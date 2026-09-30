// Deploy this plugin into a DSH profile.
//
//   node scripts/deploy.mjs [profileName]     # default: desktop
//
// The harness home follows the same precedence as DSH itself: an explicit
// $DSH_HOME, then ~/.dsh. Files are written byte-exactly (no BOM — a BOM
// breaks the profile preflight's JSON.parse and silently disables the row).
//
// After deploying, restart the harness (or reload the web page for
// browser-half-only changes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileName = process.argv[2] ?? "desktop";

function dshHome() {
  const env = process.env.DSH_HOME?.trim();
  if (!env) return path.join(os.homedir(), ".dsh");
  if (env === "~") return os.homedir();
  if (env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
  return path.resolve(env);
}

const profileDir = path.join(dshHome(), "profiles", profileName);
const pkgName = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf8")).name;
const dstDir = path.join(profileDir, "node_modules", pkgName);

if (!fs.existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`);
  process.exit(1);
}

for (const file of ["package.json", "lib/index.js", "lib/client.js"]) {
  const src = fs.readFileSync(path.join(srcDir, file));
  if (src.length >= 3 && src[0] === 0xef && src[1] === 0xbb && src[2] === 0xbf) {
    console.error(`SOURCE ${file} carries a UTF-8 BOM — strip it before deploying`);
    process.exit(1);
  }
  const dest = path.join(dstDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, src);
  console.log(`deployed ${file}`);
}

// Consistency: package name must equal the browser module id.
const client = fs.readFileSync(path.join(dstDir, "lib/client.js"), "utf8");
const loadId = client.match(/id:\s*"([^"]+)"/)[1];
if (loadId !== pkgName) {
  console.error(`name/id mismatch: package "${pkgName}" vs browser module id "${loadId}"`);
  process.exit(1);
}
console.log(`checks passed: "${pkgName}" deployed to ${dstDir}`);
console.log("restart the harness to load the changes");
