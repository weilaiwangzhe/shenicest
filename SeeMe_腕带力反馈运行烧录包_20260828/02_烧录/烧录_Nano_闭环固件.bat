@echo off
chcp 65001 >nul
setlocal
title SeeMe Nano Closed-loop Firmware Flash

set "HERE=%~dp0"
set "PORT=%~1"
if "%PORT%"=="" goto ASK_PORT
goto PORT_READY

:ASK_PORT
echo [Auto-detect Arduino Nano]
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM[0-9]+\)' -and $_.Name -match 'CH340|CH341|Arduino|Nano' }); if ($ports.Count -eq 1 -and $ports[0].Name -match '\((COM[0-9]+)\)') { $matches[1] }"`) do set "PORT=%%P"
if not "%PORT%"=="" (
  echo Detected Nano port: %PORT%
  goto PORT_READY
)

echo Auto-detect was not confident.
echo.
echo [Serial ports detected on this PC]
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM[0-9]+\)' } | Sort-Object Name | ForEach-Object { Write-Host ('  ' + $_.Name) }"
echo.
echo Enter the Arduino Nano COM port only. The Weili wristband does not need firmware flashing.
set "PORT=COM5"
set /p "PORT_IN=Enter Arduino Nano COM port [COM5]: "
if not "%PORT_IN%"=="" set "PORT=%PORT_IN%"

:PORT_READY

set "AVRDUDE=%HERE%tools\avrdude\avrdude.exe"
set "AVRCONF=%HERE%tools\avrdude\avrdude.conf"
set "HEX=%HERE%firmware_closed_loop.hex"

echo ============================================================
echo SeeMe Nano closed-loop firmware flash
echo ============================================================
echo Port:    %PORT%
echo Avrdude: %AVRDUDE%
echo Config:  %AVRCONF%
echo HEX:     %HEX%
echo.

if not exist "%AVRDUDE%" (
  echo [ERROR] avrdude.exe not found.
  pause
  exit /b 1
)

if not exist "%AVRCONF%" (
  echo [ERROR] avrdude.conf not found.
  pause
  exit /b 1
)

if not exist "%HEX%" (
  echo [ERROR] firmware_closed_loop.hex not found.
  pause
  exit /b 1
)

echo [1/2] Try Nano bootloader baud 115200...
"%AVRDUDE%" -C "%AVRCONF%" -p atmega328p -c arduino -P %PORT% -b 115200 -U flash:w:"%HEX%":i
if "%ERRORLEVEL%"=="0" goto OK

echo.
echo [2/2] 115200 failed. Try old Nano bootloader baud 57600...
"%AVRDUDE%" -C "%AVRCONF%" -p atmega328p -c arduino -P %PORT% -b 57600 -U flash:w:"%HEX%":i
if "%ERRORLEVEL%"=="0" goto OK

echo.
echo [ERROR] Flash failed.
echo Check:
echo   1. The Nano port is correct, for example COM5.
echo   2. Arduino Serial Monitor and other scripts are closed.
echo   3. The Nano driver is installed.
pause
exit /b 1

:OK
echo.
echo [OK] Flash succeeded.
pause
exit /b 0
