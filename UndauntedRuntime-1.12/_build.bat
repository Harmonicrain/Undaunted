@echo off
setlocal
REM One version-aware workflow for the runtime and both server packages.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\tools\Build-Local112.ps1" %*
exit /b %errorlevel%
