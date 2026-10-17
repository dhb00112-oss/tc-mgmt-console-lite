@echo off
setlocal
set "ADAPTER_NODE=%~dp0..\..\runtime\node-v24.21.0-win-x64\node.exe"
if not exist "%ADAPTER_NODE%" set "ADAPTER_NODE=node.exe"
"%ADAPTER_NODE%" "%~dp0tc-mgr-adapter.js"
