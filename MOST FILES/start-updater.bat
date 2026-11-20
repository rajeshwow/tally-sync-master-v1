@echo off
setlocal

rem FlexLoud Tally Agent Updater launcher (run by the "FlexLoud Tally Updater"
rem Task Scheduler task; see install-updater.bat).
rem
rem Exit codes from updater.js:
rem   0  clean stop (task ended, Ctrl+C, or another updater already running) -> stop
rem   3  updater replaced itself with a newer version                        -> restart now
rem   *  crash -> if a self-update just happened, put the previous updater back,
rem               then restart after 60 seconds

cd /d "%~dp0"

if not exist logs mkdir logs

:run
echo [%DATE% %TIME%] Updater starting >> "logs\updater-console.log"

node updater.js >> "logs\updater-console.log" 2>&1
set "CODE=%ERRORLEVEL%"

echo [%DATE% %TIME%] Updater exited with code %CODE% >> "logs\updater-console.log"

if "%CODE%"=="0" goto done
if "%CODE%"=="3" goto run

if exist "state\updater.prev.js" (
  echo [%DATE% %TIME%] New updater crashed; restoring the previous updater.js >> "logs\updater-console.log"
  rem Remember the bad version so updater.js does not install it again.
  copy /y "updater.js" "state\updater.bad.js" > nul
  copy /y "state\updater.prev.js" "updater.js" > nul
  del /q "state\updater.prev.js"
)

echo [%DATE% %TIME%] Restarting updater in 60 seconds >> "logs\updater-console.log"
timeout /t 60 /nobreak > nul
goto run

:done
endlocal
exit /b 0
