# Collects everything needed to find out why the Tally updater/agent stopped.
# Run on the RDP machine in PowerShell (as Administrator if possible):
#   powershell -ExecutionPolicy Bypass -File .\collect-diagnostics.ps1
# Optional: -UpdaterDir "C:\TallySync\updater"   -Days 3
# Output: TallyDiag-<machine>-<time>.zip on the Desktop. No passwords or tokens are copied.

param(
  [string]$UpdaterDir = "",
  [int]$Days = 3
)

$ErrorActionPreference = "Continue"
$since = (Get-Date).AddDays(-$Days)
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$out = Join-Path $env:TEMP "TallyDiag-$env:COMPUTERNAME-$stamp"
New-Item -ItemType Directory -Force $out | Out-Null
function Save($name, $data) { $data | Out-File -Encoding utf8 -Width 400 (Join-Path $out $name) }

# --- find the updater folder (from the scheduled task if not given)
$tasks = Get-ScheduledTask | Where-Object {
  ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -match "updater|sync-agent|tally"
}
if (-not $UpdaterDir) {
  foreach ($t in $tasks) { foreach ($a in $t.Actions) {
    if ($a.Execute -match "start-updater\.bat") { $UpdaterDir = Split-Path -Parent ($a.Execute.Trim('"')) }
  } }
}
if (-not $UpdaterDir -and (Test-Path "C:\TallySync\updater")) { $UpdaterDir = "C:\TallySync\updater" }

# --- 1. machine basics
$os = Get-CimInstance Win32_OperatingSystem
Save "01-machine.txt" @(
  "Machine:      $env:COMPUTERNAME"
  "Run by:       $env:USERDOMAIN\$env:USERNAME"
  "Now:          $(Get-Date)"
  "Last boot:    $($os.LastBootUpTime)"
  "Node:         $(& node -v 2>$null)"
  "Updater dir:  $UpdaterDir"
)

# --- 2. scheduled tasks: definition + last run result
$taskInfo = foreach ($t in $tasks) {
  $i = $t | Get-ScheduledTaskInfo
  "=== $($t.TaskPath)$($t.TaskName)  State=$($t.State)  LastRun=$($i.LastRunTime)  LastResult=0x$('{0:X}' -f $i.LastTaskResult)  NextRun=$($i.NextRunTime)"
  Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
  ""
}
Save "02-scheduled-tasks.txt" $taskInfo

# --- 3. Task Scheduler history (may be disabled on the machine)
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = "Microsoft-Windows-TaskScheduler/Operational"; StartTime = $since } -ErrorAction Stop |
    Where-Object { $_.Message -match "updater|sync|tally" }
  Save "03-task-history.txt" ($ev | Select-Object TimeCreated, Id, Message | Format-List | Out-String)
} catch { Save "03-task-history.txt" "Task history not available: $($_.Exception.Message)" }

# --- 4. reboots / shutdowns / crashes / logons-logoffs
$sys = Get-WinEvent -FilterHashtable @{ LogName = "System"; StartTime = $since; Id = 41, 1074, 1076, 6005, 6006, 6008, 7001, 7002 } -ErrorAction SilentlyContinue
Save "04-reboots-logoffs.txt" ($sys | Select-Object TimeCreated, Id, ProviderName, Message | Format-List | Out-String)
$app = Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $since; Level = 1, 2 } -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match "node|tally" }
Save "05-app-errors.txt" ($app | Select-Object TimeCreated, Id, ProviderName, Message | Format-List | Out-String)

# --- 5. what is running right now
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match "node|tally|cmd" } |
  Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine
Save "06-processes.txt" ($procs | Format-List | Out-String)

# --- 6. connectivity: Tally XML port + CRM
$net = @()
foreach ($p in 9000, 9999) {
  # Plain TCP connect with a 3 s limit (Test-NetConnection pings first and can be slow).
  $c = New-Object Net.Sockets.TcpClient
  $ok = $false
  try { $ok = $c.ConnectAsync("127.0.0.1", $p).Wait(3000) -and $c.Connected } catch { $ok = $false }
  $c.Close()
  $net += "Tally port ${p}: $ok"
}
try { $r = Invoke-WebRequest "https://crm.flexloud.com" -UseBasicParsing -TimeoutSec 20; $net += "CRM reachable: HTTP $($r.StatusCode)" }
catch { $net += "CRM NOT reachable: $($_.Exception.Message)" }
Save "07-network.txt" $net

# --- 7. updater files + agent log tail
if ($UpdaterDir -and (Test-Path $UpdaterDir)) {
  $u = Join-Path $out "updater"; New-Item -ItemType Directory -Force $u | Out-Null
  foreach ($f in "logs\updater.log", "logs\updater.log.1", "logs\updater-console.log", "state\state.json", "config.json") {
    $src = Join-Path $UpdaterDir $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $u ($f -replace "\\", "_")) }
  }
  Get-ChildItem $UpdaterDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\state\\(backup|staging)\\" } |
    Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 300 | Out-File -Encoding utf8 (Join-Path $u "file-list.txt")

  try {
    $cfg = Get-Content (Join-Path $UpdaterDir "config.json") -Raw | ConvertFrom-Json
    $agentDir = [IO.Path]::GetFullPath((Join-Path $UpdaterDir $cfg.agentDir))
    $log = Join-Path $agentDir "logs\agent.log"
    if (Test-Path $log) { Get-Content $log -Tail 5000 | Out-File -Encoding utf8 (Join-Path $out "08-agent-log-tail.txt") }
    Get-ChildItem (Join-Path $agentDir "logs") -File -ErrorAction SilentlyContinue |
      Select-Object Name, Length, LastWriteTime | Out-String | Out-File -Encoding utf8 (Join-Path $out "08-agent-log-files.txt")
    # .env keys only (values hidden) to check settings without leaking the token
    $envFile = Join-Path $agentDir ".env"
    if (Test-Path $envFile) {
      Get-Content $envFile | ForEach-Object { if ($_ -match "^\s*([^#=]+)=") { "$($Matches[1])=<set>" } } |
        Out-File -Encoding utf8 (Join-Path $out "09-agent-env-keys.txt")
    }
  } catch { Save "08-agent-log-tail.txt" "Could not read agent folder: $($_.Exception.Message)" }
} else {
  Save "updater-NOT-FOUND.txt" "Updater folder not found. Re-run with -UpdaterDir <path>."
}

$zip = Join-Path ([Environment]::GetFolderPath("Desktop")) "TallyDiag-$env:COMPUTERNAME-$stamp.zip"
Compress-Archive -Path "$out\*" -DestinationPath $zip -Force
Remove-Item $out -Recurse -Force
Write-Host ""
Write-Host "Done: $zip"
Write-Host "Send this zip file."
