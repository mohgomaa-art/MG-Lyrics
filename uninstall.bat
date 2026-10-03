@echo off
setlocal enabledelayedexpansion

echo.
echo  ===============================================
echo   MG Lyrics Player - Uninstall
echo  ===============================================
echo.

set "APP_NAME=MG Lyrics Player"
set "INSTALL_DIR=%LOCALAPPDATA%\MG Lyrics Player"
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP=%USERPROFILE%\Desktop"

:: ---- Confirm ----
echo This will remove MG Lyrics Player from your system.
echo.
set /p CONFIRM="Continue? (Y/N): "
if /I not "%CONFIRM%"=="Y" (echo Cancelled. && exit /b 0)

echo.

:: ---- Remove shortcuts ----
echo [1/3] Removing shortcuts...
if exist "%START_MENU%\%APP_NAME%.lnk" (
    del "%START_MENU%\%APP_NAME%.lnk"
    echo    Start Menu shortcut removed.
)
if exist "%DESKTOP%\%APP_NAME%.lnk" (
    del "%DESKTOP%\%APP_NAME%.lnk"
    echo    Desktop shortcut removed.
)

:: ---- Remove from PATH ----
echo [2/3] Removing from user PATH...
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined USER_PATH (
    set "NEW_PATH=!USER_PATH:;%INSTALL_DIR%=!"
    set "NEW_PATH=!NEW_PATH:%INSTALL_DIR%;=!"
    set "NEW_PATH=!NEW_PATH:%INSTALL_DIR%=!"
    if not "!NEW_PATH!"=="!USER_PATH!" (
        setx PATH "!NEW_PATH!" >nul 2>&1
        echo    Removed from user PATH.
    ) else (
        echo    Was not in PATH.
    )
)

:: ---- Remove install directory ----
echo [3/3] Removing installation files...
if exist "%INSTALL_DIR%" (
    rmdir /S /Q "%INSTALL_DIR%"
    echo    Installation directory removed.
) else (
    echo    Installation directory not found (already removed?).
)

echo.
echo  ===============================================
echo   Uninstall complete.
echo  ===============================================
echo.
pause
