@echo off
chcp 936 >nul
setlocal
title SeeMe Camera->Wristband Bridge

set "HERE=%~dp0"
set "SCRIPT=%HERE%nano_bridge.py"
set "PY="
set "PY_FOUND="
set "ARGS=%*"

call :TRY_PY py -3
call :TRY_PY python
call :TRY_PY "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

if not defined PY (
  if defined PY_FOUND (
    echo [ERROR] Missing Python packages: pyserial
    echo Python found: %PY_FOUND%
    echo Please run setup_runtime.bat first.
    pause
    exit /b 1
  )
  echo [ERROR] Python not found.
  echo Run setup_runtime.bat after installing Python 3.10+.
  pause
  exit /b 1
)

if not exist "%SCRIPT%" (
  echo [ERROR] Script not found: %SCRIPT%
  pause
  exit /b 1
)

cd /d "%HERE%"

echo ============================================================
echo SeeMe Camera -^> Wristband Bridge
echo ============================================================
echo Python: %PY%
echo Script: %SCRIPT%
echo.
if "%ARGS%"=="" (
  echo Args: auto port detection
) else (
  echo Args: %ARGS%
)
echo.
echo 提示: 先启动本桥，再打开化妆引导网页。
echo       网页检测到「手离开化妆区域」会自动通过本桥震动腕带。
echo.

%PY% -u "%SCRIPT%" %ARGS%
set "CODE=%ERRORLEVEL%"

echo.
echo [DONE] Exit code: %CODE%
pause
exit /b %CODE%

:TRY_PY
if defined PY exit /b 0
set "CAND_CMD=%~1"
set "CAND_ARG=%~2"
if "%CAND_ARG%"=="" (
  "%CAND_CMD%" -c "import sys" >nul 2>nul
) else (
  "%CAND_CMD%" "%CAND_ARG%" -c "import sys" >nul 2>nul
)
if errorlevel 1 exit /b 0
if "%CAND_ARG%"=="" (
  if not defined PY_FOUND set PY_FOUND="%CAND_CMD%"
  "%CAND_CMD%" -c "import serial" >nul 2>nul
) else (
  if not defined PY_FOUND set PY_FOUND="%CAND_CMD%" "%CAND_ARG%"
  "%CAND_CMD%" "%CAND_ARG%" -c "import serial" >nul 2>nul
)
if errorlevel 1 exit /b 0
if "%CAND_ARG%"=="" (
  set PY="%CAND_CMD%"
) else (
  set PY="%CAND_CMD%" "%CAND_ARG%"
)
exit /b 0
