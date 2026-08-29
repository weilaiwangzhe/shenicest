@echo off
chcp 65001 >nul
setlocal
title SeeMe EMG Diagnostic Portable
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

set "HERE=%~dp0"
set "PY="

where py >nul 2>nul
if "%ERRORLEVEL%"=="0" set "PY=py -3"

if not defined PY (
  where python >nul 2>nul
  if "%ERRORLEVEL%"=="0" set "PY=python"
)

if not defined PY (
  echo [ERROR] Python not found. Please install Python 3.10+ and run setup_runtime.bat.
  pause
  exit /b 1
)

%PY% -c "import numpy, serial" >nul 2>nul
if not "%ERRORLEVEL%"=="0" (
  echo [ERROR] Missing Python packages: numpy / pyserial
  echo Please run setup_runtime.bat first.
  pause
  exit /b 1
)

cd /d "%HERE%"
%PY% "emg_diag.py" %*
set "CODE=%ERRORLEVEL%"
echo.
echo [DONE] Exit code: %CODE%
pause
exit /b %CODE%
