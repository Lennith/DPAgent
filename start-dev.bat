@echo off
chcp 65001 >nul
setlocal

if not exist config.yaml (
  echo [ERROR] config.yaml not found.
  echo Run: node init.js  ^(or edit config.yaml manually^)
  exit /b 1
)

if not exist logs (
  mkdir logs
)

echo Starting dev web server...
echo stdout: logs\dev-web.out.log
echo stderr: logs\dev-web.err.log

call npm run dev:web:logs
exit /b %errorlevel%
