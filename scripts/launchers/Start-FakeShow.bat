@echo off
title LumenStage - Simulateur de console
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 ou plus recent est requis : https://nodejs.org
  start https://nodejs.org
  pause
  exit /b 1
)
echo Simulateur de console : envoie un show de test sur les univers 1-4.
echo Lancez aussi Start-LumenStage pour le voir dans le Monitor.
echo.
node server\fake-show.js
pause
