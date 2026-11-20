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
 * The version is bumped automatically on every release (the server rejects a
 * version that was already uploaded), in package.json and package-lock.json:
 *
 *   npm run release            1.1.1 -> 1.1.2  (patch, default: fixes)
 *   npm run release -- minor   1.1.1 -> 1.2.0  (new features)
 *   npm run release -- major   1.1.1 -> 2.0.0  (breaking changes)
 *   npm run release -- 1.5.0   exact version
 *   npm run release -- keep    no bump (re-pack the current version)
 *
 * If the build fails, the version is put back as it was.
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

const PKG_FILE = path.join(ROOT, "package.json");
const LOCK_FILE = path.join(ROOT, "package-lock.json");

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`Cannot bump non-semver version "${current}"`);
  let [major, minor, patch] = m.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${bump}". Use patch, minor, major, keep or x.y.z`);
}

/** Writes the new version to package.json and package-lock.json. */
function writeVersion(version) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, "utf8"));
  pkg.version = version;
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + "\n");

  if (fs.existsSync(LOCK_FILE)) {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    lock.version = version;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + "\n");
  }
}

function main() {
  const bump = String(process.argv[2] || "patch").trim().toLowerCase();
  const originalPkg = fs.readFileSync(PKG_FILE, "utf8");
  const originalLock = fs.existsSync(LOCK_FILE)
    ? fs.readFileSync(LOCK_FILE, "utf8")
    : null;

  const current = String(JSON.parse(originalPkg).version || "").trim();
  if (!current) throw new Error("package.json has no version");

  const version = bump === "keep" ? current : nextVersion(current, bump);
  if (version !== current) {
    writeVersion(version);
    console.log(`Version bumped: ${current} -> ${version}`);
  }

  try {
    buildBundle(version);
  } catch (error) {
    if (version !== current) {
      fs.writeFileSync(PKG_FILE, originalPkg);
      if (originalLock !== null) fs.writeFileSync(LOCK_FILE, originalLock);
      console.error(`Version restored to ${current}`);
    }
    throw error;
  }
}

function buildBundle(version) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, "utf8"));

  console.log(`Building tally-sync-agent ${version} ...`);
  // Clean build so files deleted from src/ do not linger in dist/.
  fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const files = [];
  for (const entry of INCLUDE) {
    const abs = path.join(ROOT, entry);
    if (fs.existsSync(abs)) walk(abs, entry, files);
  }

  // Ship the updater with every release: the updater on the machine replaces
  // itself with updater/updater.js when it differs (no AnyDesk needed).
  const updaterSrc = process.env.UPDATER_JS || path.resolve(ROOT, "..", "..", "tally-agent-updater", "updater.js");
  if (fs.existsSync(updaterSrc)) {
    files.push({ path: "updater/updater.js", data: fs.readFileSync(updaterSrc).toString("base64") });
    console.log(`Including updater: ${updaterSrc}`);
  } else {
    console.warn(`Updater not found at ${updaterSrc} (set UPDATER_JS); release will not update the updater.`);
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
