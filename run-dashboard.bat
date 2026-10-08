@echo off
cd /d "%~dp0"
title AKIJ Dashboard (dashboard.js)
set AKIJ_DASH_IGNORE_SIGINT=1
:loop
rem If the dashboard port is already listening, don't start a second copy.
netstat -ano | findstr /c:":8080 " | findstr /c:"LISTENING" >nul
if %errorlevel%==0 (
  ping -n 11 127.0.0.1 >nul
  goto loop
)
echo [%date% %time%] starting dashboard.js >> "server.out.log"
node dashboard.js >> "server.out.log" 2>> "server.err3.log"
echo [%date% %time%] dashboard.js exited (code %errorlevel%) - restarting in 3s >> "server.out.log"
ping -n 4 127.0.0.1 >nul
goto loop
