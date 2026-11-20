@echo off
rem One-time setup: registers the "FlexLoud Tally Updater" scheduled task.
rem Right-click -> Run as administrator.  Add "system" to run as SYSTEM:
rem   install-updater.bat system
cd /d "%~dp0"
if /i "%~1"=="system" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-updater.ps1" -System
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-updater.ps1"
)
pause
