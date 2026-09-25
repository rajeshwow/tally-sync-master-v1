@echo off
setlocal

cd /d "%~dp0.."

if not exist logs mkdir logs
set "LOG_FILE=%CD%\logs\agent.log"

echo ==========================================
echo FlexLoud Tally Sync Agent Starting
echo Folder: %CD%
echo Mode: API + single scheduler process
echo Log: %LOG_FILE%
echo ==========================================

echo [%DATE% %TIME%] Agent starting >> "%LOG_FILE%"

echo Building latest source...
call npm run build >> "%LOG_FILE%" 2>&1

if errorlevel 1 (
  echo [%DATE% %TIME%] Build failed. Agent not started. >> "%LOG_FILE%"
  echo Build failed. Agent not started. See %LOG_FILE%
  exit /b 1
)

echo Starting API agent on configured PORT...
node dist\index.js >> "%LOG_FILE%" 2>&1

echo [%DATE% %TIME%] Agent exited with code %ERRORLEVEL% >> "%LOG_FILE%"

endlocal
