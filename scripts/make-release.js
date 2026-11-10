/**
 * Builds a release bundle for the remote updater.
 *
 *   npm run release
 *
 * 1. Compiles TypeScript (npm run build).
 * 2. Packs dist/, src/, package.json, package-lock.json, tsconfig.json into
 *    releases/tally-sync-agent-<version>.agent.gz
 *
 * Upload that file in Super Admin -> Tally Agent -> Upload release.
 * Machine files (.env, logs, tmp, checkpoints, node_modules) are never packed,
 * so the client's settings and sync progress are untouched by an update.
 *
 * Bump "version" in package.json before every release: the server rejects a
 * version that was already uploaded.
 */
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const INCLUDE = ["dist", "src", "package.json", "package-lock.json", "tsconfig.json"];
const REQUIRED = ["dist/index.js", "package.json"];

function walk(absPath, relPath, out) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absPath)) {
      walk(path.join(absPath, name), `${relPath}/${name}`, out);
    }
    return;
  }
  out.push({ path: relPath, data: fs.readFileSync(absPath).toString("base64") });
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version || "").trim();
  if (!version) throw new Error("package.json has no version");

  console.log(`Building tally-sync-agent ${version} ...`);
  // Clean build so files deleted from src/ do not linger in dist/.
  fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const files = [];
  for (const entry of INCLUDE) {
    const abs = path.join(ROOT, entry);
    if (fs.existsSync(abs)) walk(abs, entry, files);
  }

  for (const required of REQUIRED) {
    if (!files.some((f) => f.path === required)) {
      throw new Error(`Build output is missing ${required}`);
    }
  }

  const manifest = {
    format: "flexloud-tally-agent-bundle",
    format_version: 1,
    name: pkg.name,
    version,
    built_at: new Date().toISOString(),
    files,
  };

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"), { level: 9 });
  const outDir = path.join(ROOT, "releases");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `tally-sync-agent-${version}.agent.gz`);
  fs.writeFileSync(outFile, gz);

  const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
  console.log("");
  console.log("Release ready");
  console.log(`  File    : ${outFile}`);
  console.log(`  Version : ${version}`);
  console.log(`  Files   : ${files.length}`);
  console.log(`  Size    : ${(gz.length / 1024).toFixed(1)} KB`);
  console.log(`  SHA-256 : ${sha256}`);
  console.log("");
  console.log("Next: upload it in Super Admin -> Tally Agent -> Upload release.");
}

try {
  main();
} catch (error) {
  console.error(`Release failed: ${error.message}`);
  process.exit(1);
}
