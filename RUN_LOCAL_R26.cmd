@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo [R26] Node.js 20+ is required on PATH.
  exit /b 2
)
node tools\run-r26-local-windows.mjs run
exit /b %ERRORLEVEL%
