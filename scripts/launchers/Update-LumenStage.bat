@echo off
title LumenStage - Update
setlocal
cd /d "%~dp0"

rem Downloads and installs the latest LumenStage build in place. Everything in
rem data\ (scenes, presets, recordings, fixture placements) is left untouched.

set "URL=https://github.com/Quentincls/ProdigyStage/releases/latest/download/LumenStage-Previz-v3.zip"
if defined LUMENSTAGE_UPDATE_URL set "URL=%LUMENSTAGE_UPDATE_URL%"
set "TMP_DIR=%TEMP%\LumenStage-update"

where curl >nul 2>nul
if errorlevel 1 (
  echo This updater needs Windows 10 or newer.
  pause
  exit /b 1
)

rmdir /s /q "%TMP_DIR%" 2>nul
mkdir "%TMP_DIR%"

echo Downloading the latest version...
curl -fL --retry 3 -o "%TMP_DIR%\LumenStage.zip" "%URL%"
if errorlevel 1 (
  echo.
  echo Download failed. Check the internet connection and try again.
  pause
  exit /b 1
)

echo Installing...
tar -xf "%TMP_DIR%\LumenStage.zip" -C "%TMP_DIR%"
if not exist "%TMP_DIR%\LumenStage\server\index.js" (
  echo The downloaded file looks incomplete. Nothing was changed.
  pause
  exit /b 1
)

rem App code is replaced wholesale; data\ is the user's and is never
rem overwritten (new data files are only added if missing).
rmdir /s /q server ui node_modules 2>nul
xcopy /e /i /q /y "%TMP_DIR%\LumenStage\server" server >nul
xcopy /e /i /q /y "%TMP_DIR%\LumenStage\ui" ui >nul
xcopy /e /i /q /y "%TMP_DIR%\LumenStage\node_modules" node_modules >nul
copy /y "%TMP_DIR%\LumenStage\README.html" README.html >nul
if exist "%TMP_DIR%\LumenStage\version.txt" copy /y "%TMP_DIR%\LumenStage\version.txt" version.txt >nul
if not exist data mkdir data
for %%f in ("%TMP_DIR%\LumenStage\data\*") do if not exist "data\%%~nxf" copy "%%f" data\ >nul

rem The block below overwrites this very .bat file, so it is parsed as a
rem single unit and ends with exit /b: cmd never reads the file again.
(
  copy /y "%TMP_DIR%\LumenStage\*.command" . >nul 2>nul
  copy /y "%TMP_DIR%\LumenStage\*.bat" . >nul 2>nul
  rmdir /s /q "%TMP_DIR%" 2>nul
  echo.
  echo Update complete.
  if exist version.txt type version.txt
  echo If LumenStage was running, close it and start it again.
  pause
  exit /b 0
)
