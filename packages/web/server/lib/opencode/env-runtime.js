/**
 * env-runtime.js — OpenCode environment helpers (bundled subprocess).
 *
 * Route B simplification: we no longer search PATH / probe login shells /
 * resolve Windows wrappers.  The bundled binary path comes from
 * lifecycle.js.  Git binary resolution is retained for Windows.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const createOpenCodeEnvRuntime = (deps) => {
  const { state } = deps;
  const runSpawnSync = typeof deps.spawnSync === 'function' ? deps.spawnSync : spawnSync;

  /* ------------------------------------------------------------------ */
  /*  Git binary resolution (Windows-only complexity)                    */
  /* ------------------------------------------------------------------ */

  const isExecutable = (filePath) => {
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return false;
      if (process.platform === 'win32') {
        const ext = path.extname(filePath).toLowerCase();
        if (!ext) return true;
        return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
      }
      accessSync(filePath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const searchPathFor = (binaryName) => {
    const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
    if (!trimmed) return null;
    const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const candidates = [trimmed];

    if (process.platform === 'win32' && !path.extname(trimmed)) {
      const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
      for (const ext of pathExt.split(';')) {
        const e = ext.trim();
        if (!e) continue;
        const name = `${trimmed}${e.startsWith('.') ? e : `.${e}`}`;
        if (!candidates.some((x) => x.toLowerCase() === name.toLowerCase())) candidates.push(name);
      }
    }

    for (const dir of parts) {
      for (const name of candidates) {
        const candidate = path.join(dir, name);
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  };

  const resolveGitBinaryForSpawn = () => {
    if (process.platform !== 'win32') return 'git';
    if (state.resolvedGitBinary) return state.resolvedGitBinary;

    const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);

    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        state.resolvedGitBinary = candidate;
        return candidate;
      }
    }

    const found = searchPathFor('git') || searchPathFor('git.exe');
    state.resolvedGitBinary = found || 'git.exe';
    return state.resolvedGitBinary;
  };

  /* ------------------------------------------------------------------ */
  /*  OpenCode binary — resolved by lifecycle from bundled path          */
  /*  We keep a diagnostic version for settings/status display.          */
  /* ------------------------------------------------------------------ */

  const resolveOpencodeCliPath = () => null; // lifecycle.js handles this

  const ensureOpencodeCliEnv = () => null;   // lifecycle.js handles this

  const applyOpencodeBinaryFromSettings = async () => null; // bundled, always

  const clearResolvedOpenCodeBinary = () => {}; // no-op

  return {
    applyLoginShellEnvSnapshot: () => {},   // no-op
    ensureOpencodeCliEnv,
    applyOpencodeBinaryFromSettings,
    getLoginShellEnvSnapshot: () => null,   // no-op
    resolveOpencodeCliPath,
    resolveManagedOpenCodeLaunchSpec: () => ({ binary: null, args: [], wrapperType: null }),
    isExecutable,
    searchPathFor,
    resolveGitBinaryForSpawn,
    clearResolvedOpenCodeBinary,
  };
};
