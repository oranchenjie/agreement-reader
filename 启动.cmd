@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8787"
set "APPNAME=AgreementReader"

echo.
echo   ==================================================
echo      协议阅读器 - 一键重启
echo   ==================================================
echo.

set "CONFIRM=Y"
set /p "CONFIRM=  按回车确认重启；输入 N 取消: "
if /i "!CONFIRM!"=="N" (
  echo   已取消。
  timeout /t 2 >nul
  exit /b 0
)

echo.
echo   [1/4] 停止已有服务 ...
set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>&1
  echo         已结束 PID %%p
  set "KILLED=1"
)
if "!KILLED!"=="0" echo         没有发现运行中的服务

rem WSL 侧也停一次（没有 WSL 或没有服务都不会报错）
wsl.exe bash -lc "pkill -f 'node server.js' >/dev/null 2>&1; exit 0" >nul 2>&1

echo.
echo   [2/4] 等待端口释放 ...
ping -n 3 127.0.0.1 >nul 2>&1

echo.
echo   [3/4] 启动服务 ...

set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for %%i in (node.exe) do if not "%%~$PATH:i"=="" set "NODE_EXE=%%~$PATH:i"

if not defined NODE_EXE (
  echo.
  echo   [错误] 找不到 Node.js
  echo          请先安装 Node.js 20 或更高版本: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo         使用: !NODE_EXE!
start "%APPNAME%" /min "!NODE_EXE!" server.js

echo.
echo   [4/4] 等待服务就绪 ...
set "READY="
for /l %%n in (1,1,30) do (
  if not defined READY (
    ping -n 2 127.0.0.1 >nul 2>&1
    netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
    if not errorlevel 1 set "READY=1"
  )
)

echo.
if defined READY (
  echo   启动成功！
  echo.
  echo   地址: http://127.0.0.1:%PORT%
  echo.
  echo   服务在任务栏那个最小化的窗口里运行。
  echo   关掉它即停止服务；也可以再运行一次本脚本强制重启。
  start "" "http://127.0.0.1:%PORT%"
) else (
  echo   [警告] 30 秒内没检测到 %PORT% 端口在监听。
  echo          请点开任务栏那个最小化窗口，看里面的报错信息。
)
echo.
pause
