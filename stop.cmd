@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-mgmt-console-lite.ps1" -PidFile "%~dp0mgmt-console-lite.pid"
if errorlevel 1 (
  echo Failed to stop the program.
  pause
  exit /b 1
)
pause
