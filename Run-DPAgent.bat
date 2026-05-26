@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

if not exist "%ROOT%node-runtime\node.exe" (
  echo [easy-run] Missing node runtime: %ROOT%node-runtime\node.exe
  exit /b 1
)

"%ROOT%node-runtime\node.exe" "%ROOT%start-easy.js"
exit /b %errorlevel%
