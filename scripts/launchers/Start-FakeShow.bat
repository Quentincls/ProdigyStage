@echo off
title LumenStage - Console simulator
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  start https://nodejs.org
  pause
  exit /b 1
)
echo Console simulator: plays a test show on universes 1-4.
echo Also launch Start-LumenStage to watch it in the previz.
echo.
node server\fake-show.js
pause
