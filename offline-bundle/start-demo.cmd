@echo off
setlocal
set "APP_PID_FILE=%~dp0mgmt-console-lite.pid"
cd /d "%~dp0app"
"%~dp0runtime\node-v24.21.0-win-x64\node.exe" src\server.js
