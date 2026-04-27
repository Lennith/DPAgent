@echo off
chcp 65001 >nul
setlocal

if not exist logs (
  mkdir logs
)

call npm run start:web:logs
exit /b %errorlevel%
