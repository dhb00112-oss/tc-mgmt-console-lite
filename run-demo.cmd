@echo off
setlocal
cd /d "%~dp0"
set "APP_PID_FILE=%~dp0mgmt-console-lite.pid"
echo Running tests...
call npm test
if errorlevel 1 (
  echo Tests failed. The server was not started.
  pause
  exit /b 1
)
echo.
echo Demo URL: http://127.0.0.1:8095
echo Demo account: demo / demo
echo Press Ctrl+C to stop.
call npm start
