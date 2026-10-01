@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or newer is required. https://nodejs.org/
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { if ((Invoke-RestMethod 'http://127.0.0.1:23000/health' -TimeoutSec 2).app -eq 'dmreader') { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  start "" "http://127.0.0.1:23000"
  exit /b 0
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
echo Starting DM Reader. Keep this window open. Press Ctrl+C to stop.
call npm start -- --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the error above.
pause
exit /b 1
