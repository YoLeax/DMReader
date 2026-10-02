@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  pause
  exit /b 1
)
node "%~dp0scripts\stop-service.ts" %*
set "stopResult=%errorlevel%"
echo.
pause
exit /b %stopResult%
