@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: MG Lyrics Player - Production Build & Global Installer Generator
:: Produces:
::   1. dist_release\MG_Lyrics_Player_Setup_v0.1.0.exe  (Universal NSIS Installer)
::   2. dist_release\portable\MG Lyrics Player.exe       (Standalone Portable Exe)
::   3. dist_release\portable\bin\yt-dlp.exe            (Bundled Audio Extractor)
:: ============================================================================

cd /d "%~dp0"
title MG Lyrics Player - Build Engine

echo.
echo ========================================================
echo   MG Lyrics Player - Production Build Engine
echo ========================================================
echo.

:: ----------------------------------------------------------------------------
:: [1/6] Verify Environment Prerequisites
:: ----------------------------------------------------------------------------
echo [1/6] Checking system toolchain...

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from: https://nodejs.org/
    pause
    exit /b 1
)

where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Rust / Cargo is not installed or not in PATH.
    echo Please install Rust from: https://rustup.rs/
    pause
    exit /b 1
)

echo        Node.js: OK
echo        Cargo:   OK

:: ----------------------------------------------------------------------------
:: [2/6] Ensure Standalone yt-dlp.exe is Present
:: ----------------------------------------------------------------------------
echo [2/6] Checking bundled yt-dlp audio extractor...

if not exist "src-tauri\bin" mkdir "src-tauri\bin"

set "YTDLP_BIN=src-tauri\bin\yt-dlp.exe"
set "NEED_DOWNLOAD=0"

if not exist "%YTDLP_BIN%" (
    set "NEED_DOWNLOAD=1"
) else (
    for %%F in ("%YTDLP_BIN%") do (
        if %%~zF equ 0 set "NEED_DOWNLOAD=1"
    )
)

if "!NEED_DOWNLOAD!"=="1" (
    echo        yt-dlp.exe not found or empty. Downloading official release...
    curl.exe -L -o "%YTDLP_BIN%" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', '%YTDLP_BIN%')" >nul 2>&1
    )
)

if not exist "%YTDLP_BIN%" (
    echo [ERROR] Failed to acquire yt-dlp.exe.
    pause
    exit /b 1
)
echo        Bundled yt-dlp: OK

:: ----------------------------------------------------------------------------
:: [3/6] Install / Validate NPM Dependencies
:: ----------------------------------------------------------------------------
echo [3/6] Checking NPM dependencies...
if not exist "node_modules" (
    echo        Installing packages...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
) else (
    echo        node_modules present.
)

:: ----------------------------------------------------------------------------
:: [4/6] Build Frontend Web Assets
:: ----------------------------------------------------------------------------
echo [4/6] Building production frontend...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Frontend compilation failed.
    pause
    exit /b 1
)

:: ----------------------------------------------------------------------------
:: [5/6] Build Tauri Release Binary & NSIS Installer
:: ----------------------------------------------------------------------------
echo [5/6] Compiling Rust release binary and building NSIS installer...
set "CI=true"
call npx tauri build --bundles nsis
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Tauri build failed.
    if not "%NON_INTERACTIVE%"=="1" pause
    exit /b 1
)

:: ----------------------------------------------------------------------------
:: [6/6] Assemble Distribution Packages
:: ----------------------------------------------------------------------------
echo [6/6] Packaging release distribution in dist_release\...

set "DIST_DIR=dist_release"
set "PORTABLE_DIR=%DIST_DIR%\portable"

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"
if not exist "%PORTABLE_DIR%" mkdir "%PORTABLE_DIR%"
if not exist "%PORTABLE_DIR%\bin" mkdir "%PORTABLE_DIR%\bin"

:: Copy NSIS Installer
set "NSIS_SRC="
for %%F in ("src-tauri\target\release\bundle\nsis\*.exe") do (
    set "NSIS_SRC=%%F"
)

if defined NSIS_SRC (
    copy /Y "!NSIS_SRC!" "%DIST_DIR%\MG_Lyrics_Player_Setup_v0.1.0.exe" >nul
    echo        Installer copied to: %DIST_DIR%\MG_Lyrics_Player_Setup_v0.1.0.exe
) else (
    echo [WARNING] NSIS bundle executable not found in bundle directory.
)

:: Copy Portable Binary & yt-dlp
set "APP_EXE=src-tauri\target\release\lyrics-temp.exe"
if exist "%APP_EXE%" (
    copy /Y "%APP_EXE%" "%PORTABLE_DIR%\MG Lyrics Player.exe" >nul
    copy /Y "%YTDLP_BIN%" "%PORTABLE_DIR%\bin\yt-dlp.exe" >nul
    echo        Portable package created at: %PORTABLE_DIR%
)

echo.
echo ========================================================
echo   BUILD SUCCESSFUL!
echo ========================================================
echo.
echo Distribution artifacts:
if exist "%DIST_DIR%\MG_Lyrics_Player_Setup_v0.1.0.exe" (
    for %%F in ("%DIST_DIR%\MG_Lyrics_Player_Setup_v0.1.0.exe") do (
        echo   [Installer]   %DIST_DIR%\MG_Lyrics_Player_Setup_v0.1.0.exe (%%~zF bytes)
    )
)
if exist "%PORTABLE_DIR%\MG Lyrics Player.exe" (
    for %%F in ("%PORTABLE_DIR%\MG Lyrics Player.exe") do (
        echo   [Portable]    %PORTABLE_DIR%\MG Lyrics Player.exe (%%~zF bytes)
    )
    echo   [Helper]      %PORTABLE_DIR%\bin\yt-dlp.exe
)
echo.
echo Features:
echo   - Universal NSIS installer: supports Per-Machine and Per-User (no admin needed)
echo   - Path safe: handles spaces, Unicode usernames, non-ASCII paths, custom drives
echo   - Zero dependencies: bundled yt-dlp audio engine included
echo   - Evergreen WebView2 auto-installer bootstrapper for any fresh Windows PC
if not defined CI if not "%NON_INTERACTIVE%"=="1" pause
