@echo off
chcp 65001 >nul
setlocal

node start.js
exit /b %errorlevel%
