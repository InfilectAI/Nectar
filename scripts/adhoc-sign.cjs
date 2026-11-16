// electron-builder afterPack hook: ad-hoc sign the .app before the DMG is built.
//
// With mac.identity=null electron-builder signs nothing, and repackaging leaves
// Electron's own signature invalid. Apple Silicon reports a downloaded app with
// a broken signature as "damaged" with no way to allow it. An ad-hoc signature
// is valid, so Gatekeeper instead offers Privacy & Security -> Open Anyway.
//
// No hardened runtime: its library validation refuses a framework whose
// signature does not share the app's Team ID, and an ad-hoc app has none.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function machOFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...machOFiles(p));
    else if (entry.isFile() && /Mach-O/.test(execFileSync("file", ["-b", p]).toString())) out.push(p);
  }
  return out;
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // --deep does not reach executables under Contents/Resources (the unpacked
  // bin/ helpers), so sign those first, then the bundle inside out.
  const resources = path.join(app, "Contents", "Resources");
  for (const bin of machOFiles(resources)) {
    execFileSync("codesign", ["--force", "--sign", "-", bin], { stdio: "inherit" });
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${app}`);
};
