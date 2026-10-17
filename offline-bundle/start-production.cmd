@echo off
setlocal
set "NODE_ENV=production"
set "APP_CONFIG=%~dp0app\config.json"
set "APP_PID_FILE=%~dp0mgmt-console-lite.pid"
cd /d "%~dp0app"
if "%TC_DB_PASSWORD%"=="" (
  echo 未检测到环境变量 TC_DB_PASSWORD（Oracle infodba 密码，用于按需查询进程日志名）。
  echo 也可以用 setx TC_DB_PASSWORD "密码" 永久设置后重开窗口，本次先临时输入。
  powershell.exe -NoProfile -Command "$p = Read-Host '请输入 Oracle 密码（留空则跳过日志查询功能启动）'; if ($p) { $env:TC_DB_PASSWORD = $p; & '%~dp0runtime\node-v24.21.0-win-x64\node.exe' 'src\server.js' } else { & '%~dp0runtime\node-v24.21.0-win-x64\node.exe' 'src\server.js' }"
) else (
  "%~dp0runtime\node-v24.21.0-win-x64\node.exe" src\server.js
)
