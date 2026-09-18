@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8787"

echo.
echo   正在停止「协议阅读器」...
echo.

set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>&1
  echo   已结束 PID %%p
  set "KILLED=1"
)

wsl.exe bash -lc "pkill -f 'node server.js' >/dev/null 2>&1; exit 0" >nul 2>&1

if "!KILLED!"=="0" echo   没有发现运行中的服务。
echo.
pause
