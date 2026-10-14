@echo off
REM WeTa Snap local card reader (Windows).
REM   run.bat            start on the port from .env, or 8099
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Load .env, if there is one. Lines starting with # are skipped.
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if not "%%~A"=="" set "%%~A=%%~B"
  )
)

if not defined OCR_HOST set "OCR_HOST=0.0.0.0"
if not defined OCR_PORT set "OCR_PORT=8099"

set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

%PY% -c "import fastapi, uvicorn" 2>NUL
if errorlevel 1 (
  echo Installing the service requirements...
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 exit /b 1
)

echo.
echo   WeTa Snap card reader on http://%OCR_HOST%:%OCR_PORT%
echo   Check it with: http://localhost:%OCR_PORT%/health
echo   From a phone on the same Wi-Fi, use this machine's IP ^(ipconfig^).
echo.

%PY% -m uvicorn main:app --host %OCR_HOST% --port %OCR_PORT%
endlocal
