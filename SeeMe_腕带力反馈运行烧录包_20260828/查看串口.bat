@echo off
chcp 65001 >nul
setlocal
title SeeMe Serial Port List

echo ============================================================
echo Current serial ports on this Windows PC
echo ============================================================
echo Look for names containing COM number, USB-SERIAL, CP210x, CH340, Arduino, or Nano.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM[0-9]+\)' } | Sort-Object Name | ForEach-Object { Write-Host ('  ' + $_.Name) }"

echo.
echo [AI/Script auto-detect view]
where py >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  py -3 "%~dp0detect_ports.py" --json
) else (
  where python >nul 2>nul
  if "%ERRORLEVEL%"=="0" python "%~dp0detect_ports.py" --json
)

echo.
echo Tips:
echo   - Weili wristband is usually CP210x / USB-SERIAL.
echo   - Arduino Nano may show as USB-SERIAL CH340, Arduino Nano, or USB Serial Device.
echo   - If unsure, unplug one device, run this again, then plug it back and compare.
echo.
pause
exit /b 0
