@echo off
setlocal enabledelayedexpansion

echo.
echo  ===============================================
echo   MG Lyrics Player - Build ^& Install
echo  ===============================================
echo.

:: ---- Configuration ----
set "APP_NAME=MG Lyrics Player"
set "INSTALL_DIR=%LOCALAPPDATA%\MG Lyrics Player"
set "EXE_NAME=MG Lyrics Player.exe"
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP=%USERPROFILE%\Desktop"

:: ---- Step 1: Check prerequisites ----
echo [1/6] Checking prerequisites...
where node >nul 2>&1 || (echo ERROR: Node.js not found. Install from https://nodejs.org && pause && exit /b 1)
where cargo >nul 2>&1 || (echo ERROR: Rust not found. Install from https://rustup.rs && pause && exit /b 1)
echo    Node.js and Rust found.

:: ---- Step 2: Install dependencies ----
echo [2/6] Installing npm dependencies...
call npm install
if %ERRORLEVEL% neq 0 (echo ERROR: npm install failed && pause && exit /b 1)

:: ---- Step 3: Build ----
echo [3/6] Building application (this may take several minutes)...
call npx tauri build 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed.
    pause
    exit /b 1
)

:: ---- Step 4: Locate and install executable ----
set "BUILD_EXE=src-tauri\target\release\%EXE_NAME%"
if not exist "%BUILD_EXE%" (
    :: Try alternative name based on Cargo.toml package name
    set "BUILD_EXE=src-tauri\target\release\lyrics-temp.exe"
)
if not exist "%BUILD_EXE%" (
    echo ERROR: Built executable not found. Listing available:
    dir /b src-tauri\target\release\*.exe 2>nul
    pause
    exit /b 1
)

echo [4/6] Installing to %INSTALL_DIR%...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%\bin" mkdir "%INSTALL_DIR%\bin"
copy /Y "%BUILD_EXE%" "%INSTALL_DIR%\%EXE_NAME%" >nul
if %ERRORLEVEL% neq 0 (echo ERROR: Failed to copy executable && pause && exit /b 1)
if exist "src-tauri\bin\yt-dlp.exe" (
    copy /Y "src-tauri\bin\yt-dlp.exe" "%INSTALL_DIR%\bin\yt-dlp.exe" >nul
)
echo    Executable and dependencies copied.

:: ---- Step 5: Add to user PATH ----
echo [5/6] Adding to user PATH...
echo %PATH% | findstr /I /C:"%INSTALL_DIR%" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
    if defined USER_PATH (
        setx PATH "!USER_PATH!;%INSTALL_DIR%" >nul 2>&1
    ) else (
        setx PATH "%INSTALL_DIR%" >nul 2>&1
    )
    echo    Added to user PATH. Restart terminal to use from anywhere.
) else (
    echo    Already in PATH.
)

:: ---- Step 6: Create shortcuts ----
echo [6/6] Creating shortcuts...

:: Start Menu shortcut
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%START_MENU%\%APP_NAME%.lnk'); $s.TargetPath = '%INSTALL_DIR%\%EXE_NAME%'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Description = 'MG Lyrics Player'; $s.Save()"
echo    Start Menu shortcut created.

:: Desktop shortcut
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP%\%APP_NAME%.lnk'); $s.TargetPath = '%INSTALL_DIR%\%EXE_NAME%'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Description = 'MG Lyrics Player'; $s.Save()"
echo    Desktop shortcut created.

echo.
echo  ===============================================
echo   Build ^& Install complete!
echo  ===============================================
echo.
echo   Installed to: %INSTALL_DIR%
echo   Start Menu:   %START_MENU%\%APP_NAME%.lnk
echo   Desktop:      %DESKTOP%\%APP_NAME%.lnk
echo.
echo   You can now:
echo     - Run "%APP_NAME%" from any new terminal
echo     - Use the Start Menu or Desktop shortcut
echo     - To uninstall, run: uninstall.bat
echo.
pause
