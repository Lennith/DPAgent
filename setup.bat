@echo off
chcp 65001 >nul
setlocal

node setup.js
exit /b %errorlevel%
