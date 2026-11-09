@echo off
rem ---------------------------------------------------------------
rem study-os - silent autostart runner.
rem
rem Called at logon by _autostart.vbs (with a hidden window), so this
rem file must never open a browser or wait for a key press.
rem
rem ASCII ONLY. cmd.exe reads .cmd files with the OEM codepage, so a
rem single non-ASCII character corrupts the lines that follow it.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

if not exist "data" mkdir "data"

rem Already listening (for example the user started it by hand):
rem do nothing, so we never end up with two servers on one port.
netstat -ano | findstr /R /C:":7788 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [%date:~0,10% %time%] already running, skipped >> "data\autostart.log"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo [%date:~0,10% %time%] ERROR: node is not in PATH >> "data\autostart.log"
  exit /b 1
)

echo [%date:~0,10% %time%] starting server >> "data\autostart.log"
rem Same as npm start: load .env when present, otherwise use built-in defaults.
node --env-file-if-exists=.env server\index.mjs >> "data\server.log" 2>&1
echo [%date:~0,10% %time%] server exited with code %errorlevel% >> "data\autostart.log"
