@echo off
setlocal

set "PORT=4000"
set "FOUND=0"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  echo [STOP] killing PID %%P on port %PORT%
  taskkill /PID %%P /F >nul 2>nul
)

if "%FOUND%"=="0" (
  echo [STOP] no listener on port %PORT%
  exit /b 0
)

timeout /t 1 /nobreak >nul
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo [STOP] failed to stop PID %%P on port %PORT%
  exit /b 1
)

echo [STOP] port %PORT% released
exit /b 0
