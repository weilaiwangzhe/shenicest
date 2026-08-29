@echo off
chcp 65001 >nul
setlocal
title SeeMe Roadshow Guarded Portable
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

set "HERE=%~dp0"
set "SCRIPT=%HERE%cosmetics_remind.py"
set "PY="
set "PY_FOUND="
set "PORT_ARGS=%*"

call :TRY_PY py -3
call :TRY_PY python
call :TRY_PY "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

if not defined PY (
  if defined PY_FOUND (
    echo [ERROR] Missing Python packages: numpy / pyserial
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
echo SeeMe Route B - Roadshow Guarded Portable
echo ============================================================
echo Python: %PY%
echo Script: %SCRIPT%
echo.

:RUN_DEMO
echo.
if "%PORT_ARGS%"=="" (
  echo Port args: auto
) else (
  echo Port args: %PORT_ARGS%
)
echo.
%PY% "%SCRIPT%" --mode both --baseline-s 3 --haptic-style legacy --lo 1.22 --mid 1.45 --hi 1.80 --hyst 0.90 --min-uv 20 --emg-score max --min-base-uv 12 --max-base-uv 60 --window-frames 12 --smooth-ms 140 --confirm-ms 100 --release-ms 160 --min-hold-ms 250 --emg-min-output-level 2 --emg-output-source raw --emg-output-mode pulse --emg-output-on 1.22 --emg-output-off 1.10 --emg-pulse-ms 220 --emg-rearm-ms 100 --tap-lo 7.0 --tap-mid 9.5 --tap-hi 11.0 --tap-release 0.5 --pulse-ms 250 --light-pulse-ms 150 --fast-pulse-ms 120 --fast-gap-ms 80 --system-ms 500 --tap-min-output-level 3 --motor-min-level 3 --rate-window-s 2 --rate-n 5 --emg-gate-ms 350 --emg-motion-gate 5.0 --emg-motion-hold-ms 300 --posture-gate-deg 75 --posture-hold-ms 250 --posture-gate-motion-only --posture-gyro-gate 3.5 --tap-max-width-ms 320 %PORT_ARGS%
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
  "%CAND_CMD%" -c "import numpy, serial" >nul 2>nul
) else (
  if not defined PY_FOUND set PY_FOUND="%CAND_CMD%" "%CAND_ARG%"
  "%CAND_CMD%" "%CAND_ARG%" -c "import numpy, serial" >nul 2>nul
)
if errorlevel 1 exit /b 0
if "%CAND_ARG%"=="" (
  set PY="%CAND_CMD%"
) else (
  set PY="%CAND_CMD%" "%CAND_ARG%"
)
exit /b 0
