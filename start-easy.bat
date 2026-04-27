@echo off
chcp 65001 >nul
setlocal

node start-easy.js
exit /b %errorlevel%
