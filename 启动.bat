@echo off
chcp 65001 >nul
title ElainaChat Mod Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)
node web\serve.mjs
echo.
echo Server stopped.
pause
