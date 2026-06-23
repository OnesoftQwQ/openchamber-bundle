/**
 * shutdown-runtime.js — graceful shutdown (bundled subprocess).
 *
 * Route B simplification: no port killing, no lsof, no binary path cleanup.
 * The managed opencode process is simply sent SIGTERM via its close() handle.
 */
export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process: nodeProcess,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    getOpenCodeProcess,
    setOpenCodeProcess,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
  } = dependencies;

  let shutdownPromise = null;

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean'
      ? options.exitProcess
      : getExitOnShutdown();

    // 1. Stop runtime services
    openCodeWatcherRuntime.stop();
    sessionRuntime.dispose();
    scheduledTasksRuntime?.stop?.();

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) clearHealthCheckInterval(healthCheckInterval);

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try { await terminalRuntime.shutdown(); } catch { /* ok */ }
      setTerminalRuntime(null);
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try { await messageStreamRuntime.close(); } catch { /* ok */ }
      setMessageStreamRuntime(null);
    }

    // 2. Stop managed OpenCode process (if any)
    const openCodeProcess = getOpenCodeProcess();
    if (openCodeProcess) {
      console.log('Stopping bundled OpenCode process...');
      try { await openCodeProcess.close(); } catch (error) {
        console.warn('Error closing OpenCode process:', error);
      }
      setOpenCodeProcess(null);
    }

    // 3. Close HTTP server
    const server = getServer();
    if (server) {
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
          }),
          new Promise((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout, forcing shutdown');
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
    }

    // 4. Dispose UI auth
    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    // 5. Stop tunnels
    const activeTunnelController = getActiveTunnelController();
    if (activeTunnelController) {
      console.log('Stopping active tunnel...');
      activeTunnelController.stop();
      setActiveTunnelController(null);
      tunnelAuthController.clearActiveTunnel();
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) nodeProcess.exit(0);
  };

  const gracefulShutdown = (options = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return { gracefulShutdown };
};
