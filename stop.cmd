@echo off
rem ---------------------------------------------------------------
rem study-os - stop the server (the node process listening on 7788).
rem ASCII ONLY - see the note in start.cmd.
rem ---------------------------------------------------------------
setlocal

set PORT=7788
set PID=

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set PID=%%p

if "%PID%"=="" (
  echo Nothing is listening on port %PORT%.
  exit /b 0
)

echo Stopping PID %PID% ...
taskkill /PID %PID% /F >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Could not stop it. Close the server window by hand.
  exit /b 1
)

echo Stopped.
