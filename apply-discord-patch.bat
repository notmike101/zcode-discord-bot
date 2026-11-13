@echo off
rem Enables the Discord bot channel in ZCode. Quit ZCode first (including its tray icon), then run this.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ must be on PATH to run the patcher.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq ZCode.exe" | find /i "ZCode.exe" >nul
if not errorlevel 1 (
  echo ZCode is still running. Quit it completely - including the system tray icon - then run this again.
  pause
  exit /b 1
)
node patch-zcode-asar.mjs
if errorlevel 1 pause
