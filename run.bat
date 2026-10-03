@echo off
cd /d "%~dp0"
echo ========================================
echo   Starting MGlyrics Desktop Player
echo ========================================
echo.
node scripts\kill-port.cjs 1420
npm run tauri dev
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Application exited with code %ERRORLEVEL%
    pause
)
