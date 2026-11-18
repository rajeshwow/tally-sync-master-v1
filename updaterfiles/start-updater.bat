@echo off
setlocal

rem FlexLoud Tally Agent Updater
rem Task Scheduler runs this file at startup INSTEAD of start-daily-sync-agent.bat.
rem The updater starts the sync agent itself and keeps it updated.

cd /d "%~dp0"

if not exist logs mkdir logs

echo [%DATE% %TIME%] Updater starting >> "logs\updater-console.log"

node updater.js >> "logs\updater-console.log" 2>&1

echo [%DATE% %TIME%] Updater exited with code %ERRORLEVEL% >> "logs\updater-console.log"

endlocal
