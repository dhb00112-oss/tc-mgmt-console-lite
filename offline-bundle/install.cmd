@echo off
setlocal
echo ==========================================================
echo  TC 管理控制台（精简版）- 离线安装 / 升级（0.2.0）
echo  默认安装目录：D:\Apps\mgmt-console-lite
echo  详细说明见同目录 README-OFFLINE.md
echo ==========================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-offline.ps1" -InstallRoot "D:\Apps\mgmt-console-lite"
if errorlevel 1 (
  echo.
  echo 安装失败，请查看上方错误信息。
  pause
  exit /b 1
)
echo.
echo 安装完成。请先按现场环境编辑 app\config.json（JMX/Oracle 地址），
echo 设置 Oracle 密码环境变量 TC_DB_PASSWORD 后运行 start-production.cmd。
echo 验收页面可先运行 start-demo.cmd。停止服务使用安装目录下的 stop.cmd。
echo.
pause
