// Wraps desktop/stage (made by build.mjs) into the Shellside app: a .dmg and .zip for macOS, an installer and a .zip
// for Windows.
//
// macOS signing: with a "Developer ID Application" certificate (CSC_LINK + CSC_KEY_PASSWORD in CI, or one in the login
// keychain) the app is signed with the hardened runtime, and notarized when App Store Connect API credentials are set
// (APPLE_API_KEY = path of the .p8 file, APPLE_API_KEY_ID, APPLE_API_ISSUER). Without a certificate it gets an ad-hoc
// signature, and macOS warns on first open. SHELLSIDE_SIGN=0 forces the ad-hoc build.
// Windows signing happens after this, through SignPath (see .github/workflows/desktop.yml and signpath/).
const { execFileSync } = require("node:child_process");

function developerIdInKeychain() {
  if (process.platform !== "darwin") return false;
  try {
    return execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).includes("Developer ID Application");
  } catch {
    return false;
  }
}

const signMac = process.env.SHELLSIDE_SIGN !== "0" && (!!process.env.CSC_LINK || !!process.env.CSC_NAME || developerIdInKeychain());
const notarize = signMac && !!(process.env.APPLE_API_KEY || process.env.APPLE_ID || process.env.APPLE_KEYCHAIN_PROFILE);
if (process.platform === "darwin") console.log(`[desktop] macOS: ${signMac ? `Developer ID signature${notarize ? ", notarized" : ", NOT notarized (no Apple credentials)"}` : "ad-hoc signature (no Developer ID certificate)"}`);

/** @type {import("app-builder-lib").Configuration} */
module.exports = {
  appId: "io.github.namyunwoo.shellside",
  productName: "Shellside",
  copyright: "Copyright © 2026 NAM YUNWOO",
  directories: { app: "stage", output: "release", buildResources: "build" },
  // Not packed into an archive: board terminals run bin/wb, and node-pty's helpers run from disk.
  asar: false,
  // The board UI is in English and Korean; Chromium's other UI languages only add size.
  electronLanguages: ["en", "en-US", "en-GB", "ko"],
  // node-pty ships prebuilt binaries for Node's stable ABI (N-API), which Electron loads as is.
  npmRebuild: false,
  nodeGypRebuild: false,
  artifactName: "Shellside-${version}-${os}-${arch}.${ext}",
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    // unset = use the Developer ID certificate (CSC_LINK or the keychain); "-" = ad-hoc.
    identity: signMac ? undefined : "-",
    hardenedRuntime: signMac,
    entitlements: signMac ? "build/entitlements.mac.plist" : undefined,
    entitlementsInherit: signMac ? "build/entitlements.mac.plist" : undefined,
    notarize,
    // A terminal app: macOS shows these when a program in a board terminal asks for access (it asks on Shellside's behalf).
    extendInfo: {
      NSHumanReadableCopyright: "Copyright © 2026 NAM YUNWOO",
      NSAppleEventsUsageDescription: "A program in a Shellside board terminal wants to control another app.",
      NSDesktopFolderUsageDescription: "A program in a Shellside board terminal wants to use files in your Desktop folder.",
      NSDocumentsFolderUsageDescription: "A program in a Shellside board terminal wants to use files in your Documents folder.",
      NSDownloadsFolderUsageDescription: "A program in a Shellside board terminal wants to use files in your Downloads folder.",
    },
  },
  dmg: { artifactName: "Shellside-${version}-mac-${arch}.${ext}" },
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "zip", arch: ["x64"] },
    ],
  },
  nsis: {
    // Per-user install (no administrator), into %LOCALAPPDATA%\Programs\Shellside, with Start menu and desktop shortcuts.
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "Shellside-Setup-${version}-${arch}.${ext}",
  },
  publish: null,
};
