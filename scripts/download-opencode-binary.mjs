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
import { readFile, writeFile } from "node:fs/promises";
import { platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
const ASSET_MAP = {
  "linux-x64": "opencode-linux-x64",
  "linux-arm64": "opencode-linux-arm64",
  "darwin-x64": "opencode-darwin-x64",
  "darwin-arm64": "opencode-darwin-arm64",
  "win32-x64": "opencode-windows-x64.exe",
  "win32-arm64": "opencode-windows-arm64.exe",
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

const getPlatformAssetName = () => {
  const key = `${platform()}-${arch()}`;
  const name = ASSET_MAP[key];
  if (!name) {
    throw new Error(
      `Unsupported platform: ${key}. Supported: ${Object.keys(ASSET_MAP).join(", ")}`
    );
  }
  return name;
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

  return new Promise((resolve, reject) => {
    const stream = createWriteStream(destPath);
    response.body.pipe(stream);

    if (total > 0) {
      response.body.on("data", (chunk) => {
        downloaded += chunk.length;
        const pct = ((downloaded / total) * 100).toFixed(1);
        process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)`);
      });
    }

    stream.on("finish", () => {
      process.stdout.write("\n");
      resolve();
    });
    stream.on("error", reject);
  });
};

const main = async () => {
  const { version: requestedVersion } = parseArgs();
  const assetName = getPlatformAssetName();
  const binaryName = platform() === "win32" ? "opencode.exe" : "opencode";

  console.log(`Target: ${assetName}`);
  console.log(`Output: ${BINARY_PATH}`);

  // Check if we already have this version
  if (existsSync(BINARY_PATH) && existsSync(VERSION_FILE)) {
    try {
      const currentVersion = (await readFile(VERSION_FILE, "utf-8")).trim();
      if (!requestedVersion || currentVersion === requestedVersion) {
        console.log(`Binary already up-to-date (${currentVersion}), skipping download.`);
        return { binaryPath: BINARY_PATH, version: currentVersion };
      }
    } catch {
      // Invalid version file, re-download
    }
  }

  // Fetch release info
  let release;
  if (requestedVersion) {
    console.log(`Fetching release ${requestedVersion}...`);
    release = await getReleaseByTag(requestedVersion);
  } else {
    console.log("Fetching latest release...");
    release = await getLatestRelease();
  }

  const asset = findAsset(release.assets, assetName);
  console.log(`Found asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

  // Download
  await downloadAsset(asset.browser_download_url, BINARY_PATH);

  // Make executable
  try {
    const { chmodSync } = await import("node:fs");
    chmodSync(BINARY_PATH, 0o755);
  } catch {
    // ignore on Windows
  }

  // Write version file
  await writeFile(VERSION_FILE, release.tag);

  console.log(`\nDone! Bundled opencode ${release.tag} at ${BINARY_PATH}`);
  return { binaryPath: BINARY_PATH, version: release.tag };
};

main().catch((err) => {
  console.error("Failed to download opencode binary:", err.message);
  process.exit(1);
});
