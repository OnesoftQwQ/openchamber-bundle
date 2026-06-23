/**
 * lifecycle.js — OpenCode process lifecycle (bundled subprocess).
 *
 * Route B simplification: opencode binary is bundled inside Electron's
 * extraResources, so we never search PATH / resolve wrappers / probe login
 * shells.  External server mode (OPENCODE_HOST / OPENCODE_SKIP_START) is
 * still supported for the web / VS Code runtimes.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const OPENCODE_HEALTH_PATH = '/global/health';

/**
 * Resolve the bundled opencode binary path at runtime.
 *
 * In Electron (packaged): process.resourcesPath points at the extraResources dir.
 * In dev / web / VS Code: check the source tree location.
 */
const getBundledBinaryPath = () => {
  // Electron packaged mode
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const candidate = join(process.resourcesPath, 'opencode-binary', exe);
    if (existsSync(candidate)) return candidate;
  }

  // Dev mode — look relative to this repo
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const devCandidate = join(
    import.meta?.url
      ? new URL('../../../../packages/electron/resources/opencode-binary', import.meta.url).pathname
      : process.cwd(),
    'packages',
    'electron',
    'resources',
    'opencode-binary',
    exe
  ).replace(/^\/([a-zA-Z]:)/, '$1'); // fix Windows absolute paths

  if (existsSync(devCandidate)) return devCandidate;

  // Fallback: just "opencode" in PATH (for CI / manual setups)
  return 'opencode';
};

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    getActiveSessionCount = () => 0,
  } = deps;

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  const hasChildExited = (child) =>
    !child || child.exitCode !== null || child.signalCode !== null;

  const isProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const isHealthy = async () => {
    if (!state.openCodeProcess || !state.openCodePort) return false;
    try {
      const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const probeExternal = async (port, origin) => {
    if (!port || port <= 0) return false;
    try {
      const base = origin ?? `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}${OPENCODE_HEALTH_PATH}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitForChildClose = (child, timeoutMs) =>
    new Promise((resolve) => {
      if (!child || hasChildExited(child)) { resolve(true); return; }
      let done = false;
      const finish = (closed) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.off('close', onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs);
      child.once('close', onClose);
    });

  const closeChild = async (child) => {
    if (!child) return;
    if (!child.pid || hasChildExited(child)) {
      await waitForChildClose(child, 250);
      return;
    }

    const pid = child.pid;
    try {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ok */ }
      }
      child.kill('SIGTERM');
    } catch { /* ok */ }

    if (await waitForChildClose(child, 2500)) return;

    // Force kill
    try {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* ok */ }
      }
      child.kill('SIGKILL');
    } catch { /* ok */ }

    await waitForChildClose(child, 1000);
  };

  /* ------------------------------------------------------------------ */
  /*  Port resolution                                                    */
  /* ------------------------------------------------------------------ */

  const allocatePort = (hostname = '127.0.0.1') =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (err) => { server.close(() => reject(err)); });
      server.once('listening', () => {
        const addr = server.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        server.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error('Failed to allocate port'));
        });
      });
      server.listen(0, hostname);
    });

  /* ------------------------------------------------------------------ */
  /*  Spawn bundled opencode                                             */
  /* ------------------------------------------------------------------ */

  const OPENCODE_START_TIMEOUT = 30_000;

  const spawnServer = async ({ hostname, port, cwd, password }) => {
    const binary = process.env.OPENCODE_BINARY || getBundledBinaryPath();
    const args = ['serve', '--hostname', hostname, '--port', String(port)];

    console.log(`[OpenCode] Launching bundled server: ${binary} ${args.join(' ')}`);

    const child = spawn(binary, args, {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const url = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let done = false;

      const finish = (handler, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
        handler(value);
      };

      const onStdout = (chunk) => {
        stdout += chunk.toString();
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('opencode server listening')) continue;
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            finish(reject, new Error(`Failed to parse URL from: ${line}`));
            return;
          }
          finish(resolve, match[1]);
          return;
        }
      };

      const onStderr = (chunk) => { stderr += chunk.toString(); };
      const onExit = (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        finish(reject, new Error(
          `OpenCode exited before ready with ${reason}\nstderr: ${stderr || '(none)'}`
        ));
      };
      const onError = (err) => finish(reject, err);

      const timer = setTimeout(
        () => finish(reject, new Error(`Timeout after ${OPENCODE_START_TIMEOUT}ms`)),
        OPENCODE_START_TIMEOUT
      );

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
    });

    return {
      url,
      pid: child.pid || null,
      close: () => closeChild(child),
    };
  };

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  const startOpenCode = async () => {
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = desiredPort > 0
      ? desiredPort
      : await allocatePort(env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    const hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME || '127.0.0.1';
    const password = env.OPENCODE_SERVER_PASSWORD || '';

    // Generate a random password if none set
    const effectivePassword = password || randomBytes(32).toString('base64');

    const instance = await spawnServer({
      hostname,
      port: spawnPort,
      cwd: state.openCodeWorkingDirectory,
      password: effectivePassword,
    });

    const parsed = new URL(instance.url);
    const port = parseInt(parsed.port, 10);
    const prefix = normalizeApiPrefix(parsed.pathname);

    if (await waitForReady(instance.url, 10_000)) {
      setOpenCodePort(port);
      setDetectedOpenCodeApiPrefix(prefix);
      state.isOpenCodeReady = true;
      state.lastOpenCodeError = null;
      state.openCodeNotReadySince = 0;
      return instance;
    }

    try { await instance.close(); } catch { /* ok */ }
    throw new Error('Server started but did not become healthy within 10s');
  };

  const restartOpenCode = async () => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      return;
    }

    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();

      // External server: just re-probe
      if (state.isExternalOpenCode) {
        const probePort = state.openCodePort || env.ENV_CONFIGURED_OPENCODE_PORT || 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternal(probePort, probeOrigin);
        if (healthy) {
          setOpenCodePort(probePort);
          state.isOpenCodeReady = true;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
        } else {
          throw new Error(`External OpenCode on port ${probePort} not responding`);
        }
        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      // Managed bundled process: stop + start
      if (state.openCodeProcess) {
        try { await state.openCodeProcess.close(); } catch { /* ok */ }
        state.openCodeProcess = null;
      }

      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      state.lastOpenCodeError = error.message;
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20_000, intervalMs = 400) => {
    if (!state.openCodePort) throw new Error('OpenCode port not available');
    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          lastError = new Error(`Health endpoint status ${response.status}`);
          await delay(intervalMs);
          continue;
        }
        const body = await response.json().catch(() => null);
        if (body?.healthy !== true) {
          lastError = new Error('Health endpoint returned unhealthy');
          await delay(intervalMs);
          continue;
        }
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }

    throw lastError || new Error('Timed out waiting for OpenCode');
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15_000, intervalMs = 300) => {
    if (!state.openCodePort) throw new Error('OpenCode port not available');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl('/agent'), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        });
        if (response.ok) {
          const agents = await response.json();
          if (Array.isArray(agents) && agents.some((a) => a?.name === agentName)) return;
        }
      } catch { /* retry */ }
      await delay(intervalMs);
    }
    throw new Error(`Agent "${agentName}" not available after restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;
    console.log(`Refreshing OpenCode after ${reason}`);
    await restartOpenCode();
    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
      if (agentName) await waitForAgentPresence(agentName);
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
      throw error;
    }
  };

  const bootstrapOpenCodeAtStartup = async () => {
    try {
      // 1. External server via host URL
      if (env.ENV_CONFIGURED_OPENCODE_HOST) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST.origin;
        console.log(`Using external OpenCode at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST.origin;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
        return;
      }

      // 2. Skip-start mode / already-running server
      if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST
          ? env.ENV_CONFIGURED_OPENCODE_HOST.origin
          : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using external OpenCode at ${label} (skip-start)`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
        return;
      }

      // 3. Auto-detect existing on configured port
      if (env.ENV_EFFECTIVE_PORT && await probeExternal(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST
          ? env.ENV_CONFIGURED_OPENCODE_HOST.origin
          : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Auto-detected OpenCode at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
        return;
      }

      // 4. Auto-detect on default port 4096
      if (!env.ENV_EFFECTIVE_PORT && await probeExternal(4096)) {
        console.log('Auto-detected OpenCode on default port 4096');
        setOpenCodePort(4096);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
        return;
      }

      // 5. Start bundled opencode
      console.log('Starting bundled OpenCode server...');
      if (env.ENV_EFFECTIVE_PORT) {
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
      }
      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode();

      try {
        await waitForOpenCodeReady();
      } catch (error) {
        console.error(`OpenCode readiness check: ${error.message}`);
      }
    } catch (error) {
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode...');
      state.lastOpenCodeError = error.message;
    }
  };

  return {
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
  };
};
