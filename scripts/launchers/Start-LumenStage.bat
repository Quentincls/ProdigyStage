@echo off
title LumenStage
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 20 or newer is required.
  echo   Install the LTS version from https://nodejs.org
  echo   then launch this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
set LUMENSTAGE_OPEN=1
node server\index.js
echo.
echo LumenStage stopped.
pause
