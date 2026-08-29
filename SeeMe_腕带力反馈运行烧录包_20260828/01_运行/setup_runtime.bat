@echo off
chcp 65001 >nul
setlocal
title SeeMe Runtime Setup

set "HERE=%~dp0"
set "PY="

where py >nul 2>nul
if "%ERRORLEVEL%"=="0" set "PY=py -3"

if not defined PY (
  where python >nul 2>nul
  if "%ERRORLEVEL%"=="0" set "PY=python"
)

if not defined PY (
  echo [ERROR] Python not found.
  echo Please install Python 3.10+ from https://www.python.org/downloads/
  echo Make sure "Add python.exe to PATH" is selected during installation.
  pause
  exit /b 1
)

echo [INFO] Python command: %PY%
echo [INFO] Installing runtime dependencies...
%PY% -m pip install -r "%HERE%requirements_runtime.txt"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [ERROR] Dependency installation failed.
  echo Check network access, Python/pip installation, or install manually:
  echo   %PY% -m pip install numpy pyserial
  pause
  exit /b %CODE%
)

echo.
echo [OK] Runtime setup complete.
pause
exit /b 0
