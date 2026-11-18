/**
 * FlexLoud Tally Agent Updater
 *
 * Runs on the client's RDP machine instead of start-daily-sync-agent.bat.
 * It
 *   1. starts the sync agent (node dist\index.js) and restarts it if it crashes,
 *   2. sends a heartbeat to the CRM every minute (version, running, syncing, errors),
 *   3. installs the release marked active in Super Admin -> Tally Agent,
 *      waiting for any running sync to finish first, and rolls back
 *      automatically if the new version does not come up healthy,
 *   4. runs commands queued from Super Admin (restart, sync now, send logs, update now).
 *
 * Zero dependencies, Node 18+. Settings come from the agent's own .env
 * (CRM_BASE_URL, CRM_TENANT_SLUG, TALLY_AGENT_TOKEN, PORT); see config.example.json
 * for the optional updater settings.
 *
 * This file is NOT replaced by agent releases. Change it rarely, by hand.
 */
"use strict";

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const UPDATER_VERSION = "1.0.0";

if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error(`Node 18 or newer is required (found ${process.version}).`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Paths + config                                                     */
/* ------------------------------------------------------------------ */

const UPDATER_DIR = __dirname;
const STATE_DIR = path.join(UPDATER_DIR, "state");
const LOG_DIR = path.join(UPDATER_DIR, "logs");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOCK_FILE = path.join(STATE_DIR, "updater.lock");
const STAGING_DIR = path.join(STATE_DIR, "staging");
const BACKUP_DIR = path.join(STATE_DIR, "backup");

const DEFAULT_CONFIG = {
  /** Sync agent folder (absolute, or relative to this updater folder). */
  agentDir: "..\\agent",
  /** New version must answer /health and stay up this long, or it is rolled back. */
  healthySeconds: 90,
  /** Longest wait for a running sync to finish before installing anyway. */
  maxSyncWaitMinutes: 180,
  /** Limit for `npm ci` when a release changes dependencies. */
  npmInstallTimeoutMinutes: 15,
};

function loadConfig() {
  let fileConfig = {};
  const configFile = path.join(UPDATER_DIR, "config.json");
  if (fs.existsSync(configFile)) {
    fileConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }
  const config = { ...DEFAULT_CONFIG, ...fileConfig };
  config.agentDir = path.resolve(UPDATER_DIR, config.agentDir);
  return config;
}

const CONFIG = loadConfig();
const AGENT_DIR = CONFIG.agentDir;

/**
 * Names in the agent folder that belong to the machine and are never
 * replaced or removed by an update. Kept in sync with the CRM validator.
 */
function isProtectedName(name) {
  const lower = String(name).toLowerCase();
  return (
    [
      ".env",
      "logs",
      "tmp",
      "node_modules",
      ".git",
      ".tally-sync-checkpoints.json",
      ".tally-sync-checkpoints.json.tmp",
    ].includes(lower) ||
    lower.startsWith(".env.") ||
    lower.endsWith(".log")
  );
}

/* ------------------------------------------------------------------ */
/* Logging                                                            */
/* ------------------------------------------------------------------ */

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const UPDATER_LOG = path.join(LOG_DIR, "updater.log");

function rotateIfLarge(file, maxBytes) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* rotation is best effort */
  }
}

function log(level, message, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${
    extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`
  }`;
  try {
    fs.appendFileSync(UPDATER_LOG, `${line}\n`);
  } catch {
    /* ignore */
  }
  if (process.stdout.isTTY) console.log(line);
}

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

function loadState() {
  try {
    return {
      installedReleaseId: null,
      installedVersion: null,
      failedReleaseIds: [],
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")),
    };
  } catch {
    return { installedReleaseId: null, installedVersion: null, failedReleaseIds: [] };
  }
}

const state = loadState();

function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/** What the CRM sees; updated as things happen, sent with each heartbeat. */
const status = {
  updateStatus: "idle", // idle | downloading | waiting_for_sync | installing | success | rolled_back | failed
  updateMessage: null,
  lastError: null,
};

let pendingEvents = [];
let pendingCommandResult = null;
let sendLogsNext = false;
let heartbeatSoon = false;

function queueEvent(type, message, version) {
  pendingEvents.push({
    type,
    message: message ? String(message).slice(0, 4000) : null,
    version: version || null,
    at: new Date().toISOString(),
  });
  if (pendingEvents.length > 100) pendingEvents = pendingEvents.slice(-100);
}

/* ------------------------------------------------------------------ */
/* Agent .env                                                         */
/* ------------------------------------------------------------------ */

function readAgentEnv() {
  const env = {};
  const file = path.join(AGENT_DIR, ".env");
  if (!fs.existsSync(file)) return env;

  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function readAgentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Single updater instance                                            */
/* ------------------------------------------------------------------ */

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

/** A lock written before the current boot is stale even if its PID was reused. */
function isLockFromThisBoot(startedAt) {
  const bootMs = Date.now() - os.uptime() * 1000;
  const startedMs = Date.parse(startedAt || "");
  return Number.isFinite(startedMs) && startedMs >= bootMs;
}

function acquireUpdaterLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (isLockFromThisBoot(existing.startedAt) && isProcessAlive(Number(existing.pid))) {
      log("ERROR", `Another updater is already running (pid ${existing.pid}). Exiting.`);
      process.exit(0);
    }
  } catch {
    /* no lock or unreadable: take it */
  }
  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
}

function releaseUpdaterLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (Number(existing.pid) === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * An agent started outside the updater (the old .bat, or one left behind when
 * the updater was killed) holds the agent's single-instance lock, so ours could
 * never start. Stop it so the updater can supervise a fresh one.
 */
async function stopUnsupervisedAgent() {
  const env = readAgentEnv();
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const lockFile = env.AGENT_LOCK_FILE || path.join(programData, "FlexLoud", "tally-sync-agent.lock");

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return;
  }

  const pid = Number(lock.pid);
  if (
    lock.hostname === os.hostname() &&
    isLockFromThisBoot(lock.startedAt) &&
    isProcessAlive(pid) &&
    pid !== process.pid
  ) {
    log("WARN", `Stopping sync agent not started by the updater (pid ${pid})`);
    queueEvent("unsupervised_agent_stopped", `Stopped agent pid ${pid} started outside the updater`);
    await killTree(pid);
    await sleep(2000);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

function hashFile(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Moves a file/folder, falling back to copy + delete across drives or when rename is refused. */
function moveSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.cpSync(src, dest, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function readFileTail(file, maxBytes, maxLines) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sync agent process                                                 */
/* ------------------------------------------------------------------ */

const agent = {
  child: null,
  startedAt: null,
  stopping: false,
  restartTimer: null,
  restartCount: 0,
  consecutiveCrashes: 0,
  recentOutput: [],
};

let updateInProgress = false;
let agentLogStream = null;

function agentLogFile() {
  return path.join(AGENT_DIR, "logs", "agent.log");
}

function writeAgentLog(text) {
  if (!agentLogStream) {
    fs.mkdirSync(path.join(AGENT_DIR, "logs"), { recursive: true });
    rotateIfLarge(agentLogFile(), 20 * 1024 * 1024);
    agentLogStream = fs.createWriteStream(agentLogFile(), { flags: "a" });
  }
  agentLogStream.write(text);
}

function rememberOutput(chunk) {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  agent.recentOutput.push(...lines);
  if (agent.recentOutput.length > 200) agent.recentOutput = agent.recentOutput.slice(-200);
}

function startAgent(reason) {
  if (agent.child) return true;
  clearTimeout(agent.restartTimer);
  agent.restartTimer = null;

  const entry = path.join(AGENT_DIR, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    status.lastError = `Cannot start agent: ${entry} not found`;
    log("ERROR", status.lastError);
    return false;
  }

  writeAgentLog(`[${new Date().toISOString()}] Agent starting via updater (${reason})\n`);
  log("INFO", `Starting sync agent (${reason})`);

  agent.recentOutput = [];
  agent.stopping = false;
  agent.startedAt = new Date();

  const child = spawn(process.execPath, [entry], {
    cwd: AGENT_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  agent.child = child;

  const onData = (chunk) => {
    writeAgentLog(chunk);
    rememberOutput(chunk);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("error", (error) => {
    log("ERROR", "Agent process error", error.message);
  });

  child.on("exit", (code, signal) => onAgentExit(child, code, signal));
  return true;
}

function onAgentExit(child, code, signal) {
  if (agent.child !== child) return;
  agent.child = null;

  const uptimeMs = agent.startedAt ? Date.now() - agent.startedAt.getTime() : 0;
  writeAgentLog(`[${new Date().toISOString()}] Agent exited (code ${code}, signal ${signal})\n`);

  if (agent.stopping) {
    agent.stopping = false;
    return;
  }

  const tail = agent.recentOutput.slice(-30).join("\n");
  status.lastError = `Agent exited unexpectedly with code ${code}.\n${tail}`;
  log("ERROR", `Agent exited unexpectedly (code ${code}, uptime ${Math.round(uptimeMs / 1000)}s)`);
  queueEvent("agent_crashed", status.lastError, readAgentVersion());

  if (updateInProgress) return; // installer decides what happens next

  agent.consecutiveCrashes = uptimeMs > 10 * 60 * 1000 ? 1 : agent.consecutiveCrashes + 1;
  const delays = [10, 30, 60, 120, 300];
  const delaySec = delays[Math.min(agent.consecutiveCrashes - 1, delays.length - 1)];
  log("INFO", `Restarting agent in ${delaySec}s`);

  agent.restartTimer = setTimeout(() => {
    agent.restartCount += 1;
    startAgent("auto-restart after crash");
  }, delaySec * 1000);
}

/** Stops the agent; resolves once the process is gone. */
async function stopAgent(reason) {
  clearTimeout(agent.restartTimer);
  agent.restartTimer = null;

  const child = agent.child;
  if (!child) return;

  log("INFO", `Stopping sync agent (${reason})`);
  agent.stopping = true;

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  const done = await Promise.race([exited.then(() => true), sleep(20000).then(() => false)]);
  if (!done) {
    log("WARN", "Agent did not stop in 20s, force killing");
    await killTree(child.pid);
    await Promise.race([exited, sleep(10000)]);
  }
  agent.child = null;
  await sleep(1000); // let Windows release file handles
}

/** Calls the agent's own local API (same token it already uses). */
async function agentLocal(pathname, { method = "GET", timeoutMs = 5000 } = {}) {
  const env = readAgentEnv();
  const port = Number(env.PORT || env.TALLY_AGENT_PORT || 5055);
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${env.TALLY_AGENT_TOKEN || ""}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * true / false when known; null when the agent is up but did not answer
 * (treated as "maybe syncing" so an update does not cut a sync short).
 */
async function isSyncRunning() {
  if (!agent.child) return false;
  try {
    const health = await agentLocal("/health");
    const d = health.body && health.body.data;
    if (!health.ok || !d) return null;
    let running = Boolean(
      d.is_running || (d.automatic_daily_sync && d.automatic_daily_sync.runtime && d.automatic_daily_sync.runtime.isRunning),
    );

    if (!running) {
      const hist = await agentLocal("/sync/historical/status").catch(() => null);
      const hd = hist && hist.body && hist.body.data;
      running = Boolean(hd && (hd.isRunning || (hd.progress && hd.progress.isRunning)));
    }
    if (!running) {
      const tx = await agentLocal("/sync/historical-transactions/status").catch(() => null);
      const td = tx && tx.body && tx.body.data;
      running = Boolean(td && td.isRunning);
    }
    return running;
  } catch {
    return null;
  }
}

/** The new version must answer /health once and still be running after `seconds`. */
async function waitHealthy(seconds) {
  const deadline = Date.now() + seconds * 1000;
  let answered = false;

  while (Date.now() < deadline) {
    await sleep(3000);
    if (!agent.child) return { ok: false, reason: "Agent exited during startup" };
    if (!answered) {
      try {
        const res = await agentLocal("/health", { timeoutMs: 3000 });
        answered = res.ok;
      } catch {
        /* still starting */
      }
    }
  }

  if (!agent.child) return { ok: false, reason: "Agent exited during startup" };
  if (!answered) return { ok: false, reason: `Agent did not answer /health within ${seconds}s` };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* CRM                                                                */
/* ------------------------------------------------------------------ */

function crmUrl(env, suffix) {
  const base = String(env.CRM_BASE_URL || "").replace(/\/$/, "");
  return `${base}/${env.CRM_TENANT_SLUG}/tally/agent/updater${suffix}`;
}

function assertCrmEnv(env) {
  const missing = ["CRM_BASE_URL", "CRM_TENANT_SLUG", "TALLY_AGENT_TOKEN"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing in ${path.join(AGENT_DIR, ".env")}: ${missing.join(", ")}`);
  }
}

async function crmJson(env, suffix, body) {
  const res = await fetch(crmUrl(env, suffix), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TALLY_AGENT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`CRM ${res.status}: ${(json && json.message) || res.statusText}`);
  }
  return json && json.data;
}

async function crmDownload(env, suffix) {
  const res = await fetch(crmUrl(env, suffix), {
    headers: { Authorization: `Bearer ${env.TALLY_AGENT_TOKEN}` },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Releases                                                           */
/* ------------------------------------------------------------------ */

function isSafeRelativePath(p) {
  if (!p || typeof p !== "string" || p.length > 400) return false;
  if (p.includes("\\") || p.includes("\0") || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Downloads, verifies and unpacks a release into state\staging\<id> (cached). */
async function ensureStaged(env, release) {
  const dir = path.join(STAGING_DIR, release.id);
  const metaFile = path.join(dir, "release.json");
  if (fs.existsSync(metaFile)) return { dir, ...JSON.parse(fs.readFileSync(metaFile, "utf8")) };

  // Only one staged release is kept.
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });

  status.updateStatus = "downloading";
  status.updateMessage = `Downloading v${release.version}`;
  log("INFO", `Downloading release ${release.version} (${release.id})`);

  const buffer = await crmDownload(env, `/releases/${release.id}/download`);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== release.sha256) {
    throw new Error(`Checksum mismatch for v${release.version} (download corrupted)`);
  }

  const manifest = JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
  if (manifest.format !== "flexloud-tally-agent-bundle" || manifest.format_version !== 1) {
    throw new Error("Unsupported release format");
  }

  const filesDir = path.join(dir, "files");
  const topLevel = new Set();
  for (const file of manifest.files || []) {
    if (!isSafeRelativePath(file.path)) throw new Error(`Unsafe path in release: ${file.path}`);
    const top = file.path.split("/")[0];
    if (isProtectedName(top)) throw new Error(`Release contains machine file: ${file.path}`);
    topLevel.add(top);
    const target = path.join(filesDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.data, "base64"));
  }
  if (!fs.existsSync(path.join(filesDir, "dist", "index.js"))) {
    throw new Error("Release has no dist/index.js");
  }

  const meta = { id: release.id, version: manifest.version, topLevel: [...topLevel] };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  log("INFO", `Release ${manifest.version} staged`, meta.topLevel);
  return { dir, ...meta };
}

function runNpmInstall(hasLock) {
  const command = hasLock
    ? "npm ci --omit=dev --no-audit --no-fund"
    : "npm install --omit=dev --no-audit --no-fund";
  log("INFO", `Running: ${command}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: AGENT_DIR, shell: true, windowsHide: true });
    let output = "";
    const collect = (d) => {
      output += d.toString("utf8");
      if (output.length > 20000) output = output.slice(-20000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      killTree(child.pid);
      reject(new Error(`npm timed out after ${CONFIG.npmInstallTimeoutMinutes} minutes`));
    }, CONFIG.npmInstallTimeoutMinutes * 60 * 1000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      fs.appendFileSync(UPDATER_LOG, `${output}\n`);
      if (code === 0) resolve();
      else reject(new Error(`npm exited with code ${code}: ${output.slice(-1500)}`));
    });
  });
}

/**
 * Swaps the agent's code for the staged release. Machine files (.env, logs,
 * checkpoints) are never touched. Rolls back on any failure.
 */
async function installRelease(release, staged) {
  updateInProgress = true;
  const fromVersion = readAgentVersion();
  const filesDir = path.join(staged.dir, "files");

  status.updateStatus = "installing";
  status.updateMessage = `Installing v${staged.version} (was v${fromVersion})`;
  queueEvent("update_started", status.updateMessage, staged.version);
  log("INFO", status.updateMessage);

  const oldLock = hashFile(path.join(AGENT_DIR, "package-lock.json"));
  const newLock = hashFile(path.join(filesDir, "package-lock.json"));
  const newHasLock = Boolean(newLock);
  const depsChanged = newHasLock
    ? oldLock !== newLock
    : hashFile(path.join(AGENT_DIR, "package.json")) !== hashFile(path.join(filesDir, "package.json"));

  const moved = [];
  let movedNodeModules = false;

  try {
    await stopAgent(`installing v${staged.version}`);

    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    for (const name of staged.topLevel) {
      const current = path.join(AGENT_DIR, name);
      if (fs.existsSync(current)) {
        moveSync(current, path.join(BACKUP_DIR, name));
        moved.push(name);
      }
    }

    const nodeModules = path.join(AGENT_DIR, "node_modules");
    if (depsChanged && fs.existsSync(nodeModules)) {
      moveSync(nodeModules, path.join(BACKUP_DIR, "node_modules"));
      movedNodeModules = true;
    }

    for (const name of staged.topLevel) {
      fs.cpSync(path.join(filesDir, name), path.join(AGENT_DIR, name), { recursive: true, force: true });
    }

    if (depsChanged || !fs.existsSync(nodeModules)) {
      status.updateMessage = `Installing npm packages for v${staged.version}`;
      await runNpmInstall(newHasLock);
    }

    status.updateMessage = `Starting v${staged.version}`;
    if (!startAgent(`update to v${staged.version}`)) throw new Error("Agent could not be started");

    const health = await waitHealthy(CONFIG.healthySeconds);
    if (!health.ok) throw new Error(health.reason);

    state.installedReleaseId = release.id;
    state.installedVersion = staged.version;
    state.lastUpdateAt = new Date().toISOString();
    saveState();

    status.updateStatus = "success";
    status.updateMessage = `Updated v${fromVersion} -> v${staged.version}`;
    status.lastError = null;
    queueEvent("update_success", status.updateMessage, staged.version);
    log("INFO", status.updateMessage);
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  } catch (error) {
    const tail = agent.recentOutput.slice(-30).join("\n");
    const reason = `${error.message}${tail ? `\n${tail}` : ""}`;
    log("ERROR", `Update to v${staged.version} failed, rolling back`, error.message);

    await stopAgent("rollback");

    try {
      for (const name of staged.topLevel) {
        fs.rmSync(path.join(AGENT_DIR, name), { recursive: true, force: true });
      }
      for (const name of moved) {
        moveSync(path.join(BACKUP_DIR, name), path.join(AGENT_DIR, name));
      }
      if (movedNodeModules) {
        fs.rmSync(path.join(AGENT_DIR, "node_modules"), { recursive: true, force: true });
        moveSync(path.join(BACKUP_DIR, "node_modules"), path.join(AGENT_DIR, "node_modules"));
      }
      status.updateStatus = "rolled_back";
      status.updateMessage = `v${staged.version} failed and was rolled back to v${fromVersion}: ${error.message}`;
    } catch (restoreError) {
      status.updateStatus = "failed";
      status.updateMessage = `v${staged.version} failed AND restore failed: ${restoreError.message}. Previous files are in ${BACKUP_DIR}`;
      log("ERROR", status.updateMessage);
    }

    state.failedReleaseIds = [...new Set([...(state.failedReleaseIds || []), release.id])];
    saveState();

    status.lastError = reason;
    sendLogsNext = true;
    queueEvent("update_failed", `${status.updateMessage}\n${reason}`, staged.version);

    startAgent("after rollback");
  } finally {
    updateInProgress = false;
  }
}

let syncWait = { releaseId: null, since: 0 };

async function maybeUpdate(env, release) {
  if (!release) {
    if (status.updateStatus === "waiting_for_sync") status.updateStatus = "idle";
    return;
  }
  if (release.id === state.installedReleaseId) return;

  if ((state.failedReleaseIds || []).includes(release.id)) {
    if (status.updateStatus !== "failed") status.updateStatus = "rolled_back";
    status.updateMessage = `v${release.version} failed earlier and was rolled back. Fix it and upload a new version, or use "Update now" to retry.`;
    return;
  }

  const staged = await ensureStaged(env, release);

  const running = await isSyncRunning();
  if (running !== false) {
    if (syncWait.releaseId !== release.id) syncWait = { releaseId: release.id, since: Date.now() };
    const waitedMin = (Date.now() - syncWait.since) / 60000;
    if (waitedMin < CONFIG.maxSyncWaitMinutes) {
      status.updateStatus = "waiting_for_sync";
      status.updateMessage = `v${release.version} downloaded; waiting for the current sync to finish (${Math.round(waitedMin)} min so far)`;
      return;
    }
    log("WARN", `Sync still busy after ${CONFIG.maxSyncWaitMinutes} min; installing anyway`);
  }

  await installRelease(release, staged);
}

/* ------------------------------------------------------------------ */
/* Commands from Super Admin                                          */
/* ------------------------------------------------------------------ */

async function runCommand(command) {
  log("INFO", `Command received: ${command}`);
  queueEvent("command", command);
  heartbeatSoon = true;

  switch (command) {
    case "restart":
      await stopAgent("restart command");
      agent.consecutiveCrashes = 0;
      pendingCommandResult = {
        command,
        result: startAgent("restart command") ? "Agent restarted" : status.lastError,
      };
      return;

    case "check_update":
      state.failedReleaseIds = [];
      saveState();
      syncWait = { releaseId: null, since: 0 };
      pendingCommandResult = { command, result: "Checking for the active release now" };
      return;

    case "send_logs":
      sendLogsNext = true;
      pendingCommandResult = { command, result: "Logs uploaded" };
      return;

    case "sync_now":
      if (!agent.child) {
        pendingCommandResult = { command, result: "Agent is not running" };
        return;
      }
      pendingCommandResult = { command, result: "Daily sync started" };
      agentLocal("/sync/daily", { method: "POST", timeoutMs: 6 * 60 * 60 * 1000 })
        .then((res) => {
          pendingCommandResult = {
            command,
            result: `Daily sync finished: HTTP ${res.status} ${(res.body && res.body.message) || ""}`,
          };
        })
        .catch((error) => {
          pendingCommandResult = { command, result: `Daily sync failed: ${error.message}` };
        })
        .finally(() => {
          heartbeatSoon = true;
        });
      return;

    default:
      pendingCommandResult = { command, result: `Unknown command: ${command}` };
  }
}

/* ------------------------------------------------------------------ */
/* Heartbeat loop                                                     */
/* ------------------------------------------------------------------ */

let heartbeatSeconds = 60;
let tickTimer = null;

async function tick() {
  heartbeatSoon = false;
  try {
    const env = readAgentEnv();
    assertCrmEnv(env);

    const syncRunning = (await isSyncRunning()) === true;
    const events = pendingEvents;
    pendingEvents = [];
    const commandResult = pendingCommandResult;
    pendingCommandResult = null;
    const includeLogs = sendLogsNext;

    const payload = {
      machine_name: os.hostname(),
      agent_version: readAgentVersion(),
      updater_version: UPDATER_VERSION,
      installed_release_id: state.installedReleaseId || null,
      agent_running: Boolean(agent.child),
      agent_pid: agent.child ? agent.child.pid : null,
      agent_started_at: agent.child && agent.startedAt ? agent.startedAt.toISOString() : null,
      agent_restart_count: agent.restartCount,
      sync_running: syncRunning,
      update_status: status.updateStatus,
      update_message: status.updateMessage,
      last_error: status.lastError,
      log_tail: includeLogs ? readFileTail(agentLogFile(), 160 * 1024, 400) : null,
      events,
      command_result: commandResult,
    };

    let data;
    try {
      data = await crmJson(env, "/heartbeat", payload);
    } catch (error) {
      // Keep what we could not deliver for the next heartbeat.
      pendingEvents = [...events, ...pendingEvents].slice(-100);
      if (commandResult && !pendingCommandResult) pendingCommandResult = commandResult;
      log("WARN", "Heartbeat failed", error.message);
      return;
    }

    if (includeLogs) sendLogsNext = false;
    if (data && data.heartbeat_seconds) {
      heartbeatSeconds = Math.min(Math.max(Number(data.heartbeat_seconds) || 60, 30), 600);
    }

    if (data && data.command) await runCommand(data.command);
    if (!updateInProgress) await maybeUpdate(env, data && data.release);
  } catch (error) {
    status.lastError = error.message;
    log("ERROR", "Updater tick failed", error.message);
    if (status.updateStatus === "downloading") {
      status.updateStatus = "failed";
      status.updateMessage = error.message;
    }
  } finally {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, heartbeatSoon ? 2000 : heartbeatSeconds * 1000);
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */

async function shutdown(signal) {
  log("INFO", `Updater stopping (${signal})`);
  clearTimeout(tickTimer);
  await stopAgent(`updater ${signal}`);
  releaseUpdaterLock();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGBREAK", () => shutdown("SIGBREAK"));
process.on("uncaughtException", (error) => log("ERROR", "Uncaught exception", error.stack || error.message));
process.on("unhandledRejection", (error) => log("ERROR", "Unhandled rejection", String(error && (error.stack || error))));

async function main() {
  rotateIfLarge(UPDATER_LOG, 5 * 1024 * 1024);
  acquireUpdaterLock();

  log("INFO", `Updater ${UPDATER_VERSION} starting`, {
    agentDir: AGENT_DIR,
    agentVersion: readAgentVersion(),
    installedReleaseId: state.installedReleaseId,
    node: process.version,
  });

  if (!fs.existsSync(path.join(AGENT_DIR, "package.json"))) {
    status.lastError = `Agent folder not found or incomplete: ${AGENT_DIR}. Set agentDir in config.json.`;
    log("ERROR", status.lastError);
  } else {
    await stopUnsupervisedAgent();
    startAgent("updater start");
  }

  queueEvent("updater_started", `Updater ${UPDATER_VERSION} on ${os.hostname()}`, readAgentVersion());
  tickTimer = setTimeout(tick, 15000); // give the agent a moment to boot
}

main().catch((error) => {
  log("ERROR", "Updater failed to start", error.stack || error.message);
  process.exit(1);
});
