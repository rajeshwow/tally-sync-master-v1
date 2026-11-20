# FlexLoud Tally Agent Updater

A small program that runs on the client's RDP machine **in place of**
`start-daily-sync-agent.bat`. It:

- starts the Tally sync agent and restarts it if it crashes,
- reports to the CRM every minute (Super Admin -> **Tally Agent**),
- installs a new agent version when you upload and activate one, waits for any
  running sync to finish first, and rolls back automatically if the new version
  does not start,
- runs commands from Super Admin: **Update now, Restart, Sync now, Get logs**.

It never touches the agent's `.env`, `logs`, `tmp`, sync checkpoint files or
`node_modules` (unless a release changes dependencies, in which case it runs
`npm ci` and can put the old `node_modules` back).

Requirements: Node 18+ (already installed for the agent). No npm packages.

---

## One-time install (needs AnyDesk once)

### 0. Before you start: save the RDP code

The first update replaces the agent's `dist` and `src` with what you build on
your laptop. If anything was edited directly on the RDP machine and not copied
back to the laptop repo, copy the RDP `src` folder to the laptop, compare it,
and commit it **before** uploading the first release.

### 1. Stop the running agent

Close the agent's console window, or in Task Scheduler right-click the agent
task and choose **End**.

### 2. Copy the updater to the RDP machine

Copy these 5 files into a new folder, for example `C:\TallySync\updater`:

- `updater.js`
- `start-updater.bat`
- `install-updater.bat` and `install-updater.ps1`
- `config.example.json`

```cmd
mkdir C:\TallySync\updater
```

### 3. Point it to the agent folder

Copy `config.example.json` to `config.json` and set `agentDir` to the folder
that holds the agent's `.env` and `package.json` today. The agent folder does
**not** need to move.

```cmd
cd /d C:\TallySync\updater
copy config.example.json config.json
notepad config.json
```

```json
{
  "agentDir": "C:\\path\\to\\tally-sync-agent",
  "healthySeconds": 90,
  "maxSyncWaitMinutes": 180,
  "npmInstallTimeoutMinutes": 15
}
```

Use double backslashes in the path.

### 4. Test it by hand

```cmd
cd /d C:\TallySync\updater
node updater.js
```

Within about a minute the machine appears in Super Admin -> Tally Agent ->
Agents as **Online / Running**. Check `C:\TallySync\updater\logs\updater.log`
for problems. Press `Ctrl+C` to stop it (this also stops the agent).

### 5. Install the scheduled task (once)

Right-click `install-updater.bat` -> **Run as administrator** (asks for this
Windows user's password once). Use `install-updater.bat system` instead to run
it as SYSTEM with no password.

It creates the task **FlexLoud Tally Updater**, which:

- starts at boot, with nobody logged in, and keeps running after RDP logoff,
- checks every 5 minutes and starts the updater again if it has died,
- disables the old tasks that ran `start-daily-sync-agent.bat` / `start-updater.bat`.

`start-updater.bat` itself restarts the updater 60 s after a crash.

---

## Releasing a new agent version (from your laptop)

1. Make and test your change in the sync agent repo.
2. Bump `"version"` in `package.json` (for example 1.1.1 -> 1.1.2).
3. Build the release:

   ```cmd
   npm run release
   ```

   This creates `releases\tally-sync-agent-1.1.2.agent.gz`.
4. Super Admin -> Tally Agent -> **Upload release**. Choose the file, pick the
   tenant (or All tenants), keep **Make active now** ticked.
5. Within about a minute the Agents tab shows *Downloading* -> *Installing* ->
   *Updated*. If a sync is running it shows *Waiting for sync* first.

**Rollback:** Releases tab -> older version -> **Roll back to this**.

If a new version crashes on start, the updater restores the previous version
by itself, shows *Rolled back* with the error, uploads the agent log, and does
not retry that release. Fix the code, bump the version and upload again, or use
**Update now** to retry the same release.

---

## Files the updater creates

| Path | What |
|---|---|
| `logs\updater.log` | Updater activity (rotated at 5 MB) |
| `logs\updater-console.log` | Startup crashes, written by the .bat |
| `state\state.json` | Installed release id, failed releases |
| `state\backup\` | Previous agent files from the last update |
| `state\staging\` | Downloaded release waiting to be installed |

The agent's own output still goes to `<agentDir>\logs\agent.log`.

## Updating the updater itself

`npm run release` in the agent repo also packs `..\..\tally-agent-updater\updater.js`
(override with `UPDATER_JS`) as `updater/updater.js`. After installing a release
the updater compares that file with itself; if it differs it replaces itself
(old copy kept in `state\updater.prev.js`) and restarts. If the new updater
crashes, `start-updater.bat` restores the old one and will not install that
version again. Only `start-updater.bat` / `install-updater.*` changes need AnyDesk.

The CRM emails `TALLY_AGENT_ALERT_EMAILS` when an updater has not reported for
`TALLY_AGENT_OFFLINE_ALERT_MINUTES` (default 15), once per outage.
