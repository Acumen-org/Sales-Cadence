@echo off
title Cadence
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules\.bin\next.cmd (
  echo Installing dependencies (first run only)...
  where pnpm >nul 2>&1
  if errorlevel 1 (
    call npm install -g pnpm@9
  )
  call pnpm install
  if errorlevel 1 (
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

echo Starting Cadence... the browser opens when it is ready. Close this window to stop.
node node_modules\tsx\dist\cli.mjs scripts\start-local.ts
echo.
echo Cadence stopped.
pause
