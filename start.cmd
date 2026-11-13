@echo off
setlocal
title study-os - cuoti zhongshu
cd /d "%~dp0"

rem If the port is already listening, the server is up: just open the page.
rem Do NOT put non-ASCII text in this file - cmd.exe reads it with the OEM
rem codepage, and multibyte chars corrupt the following line.

netstat -ano | findstr /R /C:":7788 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo  Already running - opening the page...
  echo.
  start "" "http://127.0.0.1:7788"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found.
  echo  Install it from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

rem --- Firewall: phones can only connect if the inbound port is allowed.  ---
rem Asking here means the user sees the reason; the actual change still
rem needs their UAC confirmation.
node tools/firewall.mjs status > "%TEMP%\sos-fw.txt" 2>nul
findstr /C:"absent" "%TEMP%\sos-fw.txt" >nul 2>nul
if not errorlevel 1 goto fw_checked
findstr /C:"no rule" "%TEMP%\sos-fw.txt" >nul 2>nul
if errorlevel 1 goto fw_checked
echo.
echo  [LAN] Phones cannot reach this PC until the firewall allows port 7788.
set /p ALLOW_FW="       Add the rule now? It will pop up a UAC prompt. [y/N] "
if /i not "%ALLOW_FW%"=="y" goto fw_checked
echo.
echo       Requesting administrator permission...
node tools/firewall.mjs add
:fw_checked
del "%TEMP%\sos-fw.txt" >nul 2>nul

if not exist node_modules (
  echo.
  echo  First run - installing dependencies, please wait...
  echo.
  call npm install --cache .npm-cache --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed. Check your network.
    echo.
    pause
    exit /b 1
  )
)

rem Open the browser as soon as the port actually answers (polled by a helper),
rem instead of guessing a fixed delay - a slow first start would otherwise
rem show a connection error.

start "" /min "%~dp0_wait-and-open.cmd"

echo.
echo  ============================================================
echo    study-os is starting...
echo.
echo    The real local + LAN addresses are printed just below.
echo    On the phone: scan the QR code shown on the home page.
echo.
echo    Close this window to stop the server.
echo  ============================================================
echo.

call npm start
echo.
echo  Server stopped.
pause