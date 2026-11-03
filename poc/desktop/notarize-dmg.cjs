// electron-builder afterAllArtifactBuild hook: notarize and staple the signed .dmg files too (electron-builder notarizes
// only the app inside). Runs when the app was signed and App Store Connect API credentials are set; otherwise skips.
const { execFileSync } = require("node:child_process");

module.exports = async function notarizeDmgs(result) {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const dmgs = result.artifactPaths.filter((p) => p.endsWith(".dmg"));
  if (!dmgs.length || process.platform !== "darwin") return [];
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log("  • skipped notarizing the .dmg files  reason=no App Store Connect API credentials");
    return [];
  }
  for (const dmg of dmgs) {
    try {
      execFileSync("codesign", ["--verify", dmg], { stdio: "ignore" });
    } catch {
      console.log(`  • skipped notarizing ${dmg}  reason=not signed`);
      continue;
    }
    console.log(`  • notarizing       file=${dmg}`);
    execFileSync("xcrun", ["notarytool", "submit", dmg, "--key", APPLE_API_KEY, "--key-id", APPLE_API_KEY_ID, "--issuer", APPLE_API_ISSUER, "--wait"], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
