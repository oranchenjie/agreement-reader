@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  Agreement Reader - Diagnostics
echo ============================================================
echo.
echo [1] Current Windows directory
echo     %CD%
echo.
echo [2] wsl.exe location
where wsl.exe
echo.
echo [3] WSL distributions
wsl.exe -l -v
echo.
echo [4] WSL cwd inheritance + distro
wsl.exe bash -lc "echo distro=$(lsb_release -ds 2>/dev/null); echo pwd=$(pwd); echo whoami=$(whoami)"
echo.
echo [5] Is run.sh visible from WSL cwd?
wsl.exe bash -lc "ls -la run.sh 2>&1 | head -3"
echo.
echo [6] Node inside WSL
wsl.exe bash -lc "node -v 2>&1; which node 2>&1"
echo.
echo [7] run.sh status
wsl.exe bash -lc "if [ -f run.sh ]; then ./run.sh status; else echo 'run.sh NOT FOUND'; fi"
echo.
echo ============================================================
echo  Please copy everything above and send it back.
echo ============================================================
pause
