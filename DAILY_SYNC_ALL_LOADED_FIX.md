# Daily Sync: All Loaded Tally Companies (v1.1.1)

## RCA in the previous version

1. `.env.production.example` shipped with `DISABLE_AUTO_SYNC=true`. The production API process (`src/index.ts`) checks this flag and does not register the cron scheduler when it is true.
2. Production starts `dist/index.js`. The separate `daily-sync.runner.ts` was not used by the production start commands, so its `DAILY_SYNC_ENABLED`, `DAILY_SYNC_RUN_ON_START`, startup polling, and daily overlap protection did not control the real scheduler.
3. `src/daily-sync.service.ts` explicitly called `resolveCurrentTallyCompany()`, so only the currently selected company was synced.
4. The API scheduler had no daily-level mutex during the masters phase. A run taking more than 30 minutes could overlap with the next cron tick.
5. The daily transaction range is a rolling `DAILY_SYNC_LOOKBACK_DAYS` window, not a per-company last-success checkpoint. A voucher dated outside that window is not pulled.
6. The repository does not install a Windows service or Scheduled Task. If the BAT file is started in an interactive RDP session, the agent stops when that process/session is closed or terminated.

## New daily flow

- One API + scheduler process: `dist/index.js`.
- Every cron run discovers all companies currently loaded in the connected Tally instance using the TDL `Company` collection.
- Masters run sequentially for every loaded company.
- Sales vouchers, purchase vouchers, outstandings, and delivery challans run sequentially for every loaded company for the rolling lookback range.
- Company name is passed through `SVCURRENTCOMPANY` for every module request.
- A daily mutex prevents overlapping daily runs.
- `/health` now reports scheduler configuration and the last automatic daily-sync status.
- Manual/historical routes still use `TALLY_COMPANIES`; automatic daily sync intentionally bypasses that allowlist and processes all loaded companies.

## Required production `.env`

```env
DISABLE_AUTO_SYNC=false
DAILY_SYNC_ENABLED=true
DAILY_SYNC_RUN_ON_START=true
SYNC_INTERVAL_MINUTES=30
SYNC_CRON=*/30 * * * *
DAILY_SYNC_LOOKBACK_DAYS=3
```

`SYNC_CRON=*/30 * * * *` runs at minute `00` and `30` of every hour.

## Start

```bat
scripts\start-daily-sync-agent.bat
```

Use only one process. Do not separately start `daily-sync.runner.js`.

## Verify

```bat
curl.exe -H "Authorization: Bearer {{token}}" http://127.0.0.1:5050/health
```

Expected fields:

- `automatic_daily_sync.enabled: true`
- `automatic_daily_sync.company_selection: all_loaded_companies`
- `automatic_daily_sync.cron: */30 * * * *`
- after a run, `automatic_daily_sync.runtime.lastStartedAt` and `lastCompletedAt` are populated

Loaded-company diagnostics:

```bat
curl.exe -H "Authorization: Bearer {{token}}" http://127.0.0.1:5050/diagnostics/companies
```

The `available` array is the set returned by the connected Tally instance's `Company` collection and is the set used by automatic daily sync.

Run the exact daily flow immediately:

```bat
curl.exe -X POST -H "Authorization: Bearer {{token}}" http://127.0.0.1:5050/sync/daily
```
