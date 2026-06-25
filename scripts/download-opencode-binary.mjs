/**
 * download-opencode-binary.mjs
 *
 * Build-time script: downloads the latest opencode CLI binary for the current
 * platform and places it in packages/electron/resources/opencode-binary/ so
 * electron-builder can bundle it as an extraResource.
 *
 * Usage:
 *   node scripts/download-opencode-binary.mjs          # auto-detect platform
 *   node scripts/download-opencode-binary.mjs --version v1.17.9   # specific version
 */

import { chmodSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TARGET_DIR = join(
  REPO_ROOT,
  "packages",
  "electron",
  "resources",
  "opencode-binary"
);

const BINARY_NAME = platform() === "win32" ? "opencode.exe" : "opencode";
const BINARY_PATH = join(TARGET_DIR, BINARY_NAME);
const VERSION_FILE = join(TARGET_DIR, "version.txt");

// Map Node's process.platform + process.arch to GitHub release asset names.
// OpenCode publishes prebuilt binaries via GitHub releases.
// GitHub releases publish assets as .tar.gz archives (non-Windows) or .zip
const ASSET_MAP = {
  "linux-x64":      { name: "opencode-linux-x64-baseline.tar.gz", extract: true },
  "linux-arm64":    { name: "opencode-linux-arm64.tar.gz",       extract: true },
  "darwin-x64":     { name: "opencode-darwin-x64.zip",           extract: true },
  "darwin-arm64":   { name: "opencode-darwin-arm64.zip",         extract: true },
  "win32-x64":      { name: "opencode-windows-x64-baseline.zip", extract: true },
  "win32-arm64":    { name: "opencode-windows-arm64.zip",        extract: true },
};

const GITHUB_REPO = "anomalyco/opencode";
const GITHUB_API = "https://api.github.com";

const parseArgs = () => {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && i + 1 < args.length) {
      version = args[i + 1];
      i++;
    }
  }
  return { version };
};

const getPlatformAsset = () => {
  const key = `${platform()}-${arch()}`;
  const config = ASSET_MAP[key];
  if (!config) {
    throw new Error(
      `Unsupported platform: ${key}. Supported: ${Object.keys(ASSET_MAP).join(", ")}`
    );
  }
  return { ...config, key };
};

const getLatestRelease = async () => {
  const url = `${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openchamber-bundled-build",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch latest release: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.json();
  return { tag: data.tag_name, assets: data.assets };
};

const getReleaseByTag = async (tag) => {
  const url = `${GITHUB_API}/repos/${GITHUB_REPO}/releases/tags/${tag}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openchamber-bundled-build",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch release ${tag}: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.json();
  return { tag: data.tag_name, assets: data.assets };
};

const findAsset = (assets, assetName) => {
  const asset = assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `Asset "${assetName}" not found in release. Available: ${assets.map((a) => a.name).join(", ")}`
    );
  }
  return asset;
};

const downloadAsset = async (url, destPath) => {
  console.log(`Downloading ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`
    );
  }

  const total = parseInt(response.headers.get("content-length") || "0", 10);
  let downloaded = 0;

  mkdirSync(dirname(destPath), { recursive: true });

  const writer = createWriteStream(destPath);
  const reader = Readable.fromWeb(response.body);

  if (total > 0) {
    reader.on("data", (chunk) => {
      downloaded += chunk.length;
      const pct = ((downloaded / total) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)`);
    });
  }

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      process.stdout.write("\n");
      resolve();
    });
    writer.on("error", reject);
    reader.pipe(writer);
  });
};

const extractArchive = (archivePath, destDir, format) => {
  mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // Windows: PowerShell Expand-Archive for zip, tar (built-in) for tar.gz
    if (format === 'zip') {
      const result = spawnSync('powershell', [
        '-NoLogo', '-NoProfile', '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`Expand-Archive failed with code ${result.status}`);
    } else {
      const result = spawnSync('tar', ['xzf', archivePath, '-C', destDir], {
        stdio: 'inherit',
      });
      if (result.status !== 0) throw new Error(`tar extraction failed with code ${result.status}`);
    }
    return;
  }

  // Unix: unzip for zip, tar for tar.gz
  if (format === 'zip') {
    const result = spawnSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`unzip failed with code ${result.status}`);
    return;
  }

  const result = spawnSync('tar', ['xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`tar extraction failed with code ${result.status}`);
};

const main = async () => {
  const { version: requestedVersion } = parseArgs();
  const platformAsset = getPlatformAsset();
  const binaryName = platform() === 'win32' ? 'opencode.exe' : 'opencode';
  const archiveFormat = platformAsset.name.endsWith('.zip') ? 'zip' : 'tar.gz';

  console.log(`Target asset: ${platformAsset.name}`);
  console.log(`Output dir: ${TARGET_DIR}`);

  // Check cache
  if (existsSync(BINARY_PATH) && existsSync(VERSION_FILE)) {
    try {
      const currentVersion = (await readFile(VERSION_FILE, 'utf-8')).trim();
      if (!requestedVersion || currentVersion === requestedVersion) {
        console.log(`Binary already up-to-date (${currentVersion}), skipping download.`);
        return { binaryPath: BINARY_PATH, version: currentVersion };
      }
    } catch {
      // re-download
    }
  }

  // Fetch release
  let release;
  if (requestedVersion) {
    console.log(`Fetching release ${requestedVersion}...`);
    release = await getReleaseByTag(requestedVersion);
  } else {
    console.log('Fetching latest release...');
    release = await getLatestRelease();
  }

  const ghAsset = findAsset(release.assets, platformAsset.name);
  const archivePath = join(TARGET_DIR, platformAsset.name);
  console.log(`Downloading ${ghAsset.name} (${(ghAsset.size / 1024 / 1024).toFixed(1)} MB)...`);

  await downloadAsset(ghAsset.browser_download_url, archivePath);

  // Extract archive
  console.log('Extracting...');
  extractArchive(archivePath, TARGET_DIR, archiveFormat);

  // The binary is inside the archive — ensure it's at BINARY_PATH.
  // Archives typically contain a single binary or a directory with the binary.
  if (!existsSync(BINARY_PATH)) {
    const { readdirSync, renameSync } = await import('node:fs');
    const findBinary = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findBinary(full);
          if (found) return found;
        } else if (entry.name === binaryName) {
          return full;
        }
      }
      return null;
    };
    const found = findBinary(TARGET_DIR);
    if (found && found !== BINARY_PATH) {
      renameSync(found, BINARY_PATH);
    }
  }

  // Clean up archive
  try { await unlink(archivePath); } catch { /* ok */ }

  // Make executable
  try { chmodSync(BINARY_PATH, 0o755); } catch { /* ignore on Windows */ }

  // Write version
  await writeFile(VERSION_FILE, release.tag);
  console.log(`\nDone! Bundled opencode ${release.tag} at ${BINARY_PATH}`);
  return { binaryPath: BINARY_PATH, version: release.tag };
};

main().catch((err) => {
  console.error("Failed to download opencode binary:", err.message);
  process.exit(1);
});
