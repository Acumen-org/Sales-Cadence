@echo off
setlocal
title Cadence
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto :nonode

if exist node_modules\tsx\dist\cli.mjs goto :run

echo Installing dependencies - first run only, this takes a few minutes...
where pnpm >nul 2>&1
if errorlevel 1 call npm install -g pnpm@9
call pnpm install
if errorlevel 1 goto :installfailed

:run
echo Starting Cadence. The browser opens when it is ready. Close this window to stop.
node node_modules\tsx\dist\cli.mjs scripts\start-local.ts
echo.
echo Cadence stopped.
pause
exit /b 0

:nonode
echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this again.
pause
exit /b 1

:installfailed
echo Dependency install failed. See the messages above.
pause
exit /b 1
