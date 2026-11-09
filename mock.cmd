@echo off
setlocal
title study-os mock model (preview only)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo    LOCAL MOCK MODEL - for previewing the flow, costs nothing
echo.
echo    Base URL : http://127.0.0.1:7799/v1
echo    API Key  : mock
echo    Vision   : mock-vl-1
echo    Text     : mock-text-1
echo.
echo    It returns HARD-CODED sample data, not real recognition.
echo    Close this window to stop it.
echo  ============================================================
echo.

node tools/mock-ai.mjs
echo.
echo  Mock stopped.
pause
