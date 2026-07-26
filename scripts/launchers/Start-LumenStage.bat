@echo off
title LumenStage
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 20 ou plus recent est requis.
  echo   Installation : https://nodejs.org  ^(version LTS^)
  echo   Relancez ensuite ce fichier.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
set LUMENSTAGE_OPEN=1
node server\index.js
echo.
echo LumenStage s'est arrete.
pause
