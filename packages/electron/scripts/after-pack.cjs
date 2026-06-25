const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set([
  'en-US.pak', 'en.pak',
  'zh-CN.pak', 'zh-TW.pak',
]);

module.exports = (context) => {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    const appBundlePath = path.join(context.appOutDir, `${appName}.app`);
    const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
    const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

    if (!fs.existsSync(sourceAssetsPath)) {
      throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
    }

    fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
    return;
  }

  // Linux: strip unnecessary Chromium locale .pak files
  if (context.electronPlatformName === 'linux') {
    const localesDir = path.join(context.appOutDir, 'locales');
    if (!fs.existsSync(localesDir)) return;

    let removed = 0;
    for (const entry of fs.readdirSync(localesDir)) {
      if (entry.endsWith('.pak') && !KEEP_LOCALES.has(entry)) {
        fs.unlinkSync(path.join(localesDir, entry));
        removed++;
      }
    }
    console.log(`[afterPack] Removed ${removed} locale files from ${localesDir}`);
  }
};
