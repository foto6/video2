@echo off
setlocal
cd /d "%~dp0"
node tools\run-r26-local-windows.mjs verify
exit /b %ERRORLEVEL%
