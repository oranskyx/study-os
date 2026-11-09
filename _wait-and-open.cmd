@echo off
rem Wait until the app answers on port 7788, then open it in the default browser.
rem Called in the background by start.cmd. ASCII only - see start.cmd note.

setlocal
for /l %%i in (1,1,60) do (
  netstat -ano | findstr /R /C:":7788 .*LISTENING" >nul 2>nul
  if not errorlevel 1 (
    start "" "http://127.0.0.1:7788"
    exit /b 0
  )
  ping -n 2 127.0.0.1 >nul
)
exit /b 1
