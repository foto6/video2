@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: RUN_LOCAL_R27.cmd "E:\path\input.mp4" "E:\path\r27-output"
  exit /b 2
)
if "%~2"=="" (
  echo Usage: RUN_LOCAL_R27.cmd "E:\path\input.mp4" "E:\path\r27-output"
  exit /b 2
)
where node >nul 2>nul || (
  echo [R27] Node.js 20+ is required on PATH.
  exit /b 2
)
node tools\run-r27-real-input-local.mjs run --input "%~1" --output-root "%~2"
exit /b %ERRORLEVEL%
