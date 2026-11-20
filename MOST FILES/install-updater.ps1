# FlexLoud Tally Agent Updater - one-time Task Scheduler setup.
#
# Run from an elevated PowerShell in the updater folder (or double-click
# install-updater.bat, which elevates for you):
#
#   .\install-updater.ps1            run as the current Windows user (asks for the password once)
#   .\install-updater.ps1 -System    run as SYSTEM (no password; survives password changes)
#
# Creates the task "FlexLoud Tally Updater" that:
#   - starts at boot, without anyone logging in,
#   - keeps running when the RDP user logs off,
#   - re-checks every 5 minutes and starts the updater again if it has died
#     (if it is already running, the check does nothing),
#   - restarts it every minute after a failure.
# Old tasks that ran start-daily-sync-agent.bat or start-updater.bat are disabled
# so only this one starts the updater.

param([switch]$System)

$ErrorActionPreference = "Stop"
$TaskName = "FlexLoud Tally Updater"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bat = Join-Path $Dir "start-updater.bat"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this as Administrator (right-click install-updater.bat -> Run as administrator)."
}
if (-not (Test-Path $Bat)) { throw "start-updater.bat not found in $Dir" }
if (-not (Test-Path (Join-Path $Dir "config.json"))) { throw "config.json not found in $Dir (copy config.example.json and set agentDir)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is not on PATH" }

# 1. Disable older tasks that start the agent or updater, so nothing runs twice.
Get-ScheduledTask | Where-Object { $_.TaskName -ne $TaskName } | ForEach-Object {
  $task = $_
  foreach ($a in $task.Actions) {
    $text = "$($a.Execute) $($a.Arguments)"
    if ($text -match "start-daily-sync-agent|start-updater\.bat") {
      if ($task.State -eq "Running") { Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath }
      Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null
      Write-Host "Disabled old task: $($task.TaskPath)$($task.TaskName)"
      break
    }
  }
}

# 2. Register the task.
$start = (Get-Date).AddMinutes(1).ToString("yyyy-MM-ddTHH:mm:ss")
if ($System) {
  $principalXml = "<Principal id=`"Author`"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>"
} else {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $principalXml = "<Principal id=`"Author`"><UserId>$user</UserId><LogonType>Password</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>"
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Keeps the FlexLoud Tally sync updater (and through it the sync agent) running.</Description></RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled><Delay>PT1M</Delay></BootTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>$start</StartBoundary>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>$principalXml</Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>"$Bat"</Command><WorkingDirectory>$Dir</WorkingDirectory></Exec>
  </Actions>
</Task>
"@

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($System) {
  Register-ScheduledTask -TaskName $TaskName -Xml $xml | Out-Null
} else {
  $cred = Get-Credential -UserName $user -Message "Windows password for $user (needed so the task runs while nobody is logged in)"
  Register-ScheduledTask -TaskName $TaskName -Xml $xml -User $user -Password $cred.GetNetworkCredential().Password | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Write-Host ""
Write-Host "Installed and started task '$TaskName'."
Write-Host "Check Super Admin -> Tally Agent: this machine should show Online within 1-2 minutes."
