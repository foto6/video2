@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: VERIFY_LOCAL_R27.cmd "E:\path\r27-output"
  exit /b 2
)
node tools\run-r27-real-input-local.mjs verify --output-root "%~1"
exit /b %ERRORLEVEL%
