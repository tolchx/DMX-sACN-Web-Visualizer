@echo off
setlocal enabledelayedexpansion
color 0A
title DMX Web Visualizer - Installer

echo =======================================================
echo DMX / sACN Web Visualizer ^& Bridge - Install Target
echo =======================================================
echo.
echo Checking for Node.js...

:: Check for node
where node >nul 2>nul
if errorlevel 1 (
    echo [WARNING] Node.js is not installed on this system!
    echo Attempting to install Node.js automatically via Windows Package Manager ^(winget^)...
    
    :: Try installing via winget
    winget install OpenJS.NodeJS -e --accept-source-agreements --accept-package-agreements
    
    if errorlevel 1 (
        echo.
        echo [ERROR] Automatic installation failed or Winget is not available.
        echo Please download and install Node.js manually from:
        echo https://nodejs.org/en/download
        echo Once installed, close this window and run install.bat again.
        pause
        exit /b
    )
    echo.
    echo Node.js installed successfully! 
    echo Please CLOSE this window and open install.bat again to refresh the system Path.
    pause
    exit /b
)

echo Node.js detected.
echo.
echo Checking for npm...
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is installed but npm was not found in the Path.
    echo Please ensure Node.js is correctly installed.
    pause
    exit /b
)

echo npm detected.
echo.
echo Installing required dependencies ^(express, socket.io, e131^)...
echo This may take a minute...
echo.

:: Run npm install
call npm install --no-audit --no-fund

if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed!
    echo Please check your internet connection and try running 'npm install' manually.
    pause
    exit /b
)

echo.
echo =======================================================
echo [+] Installation Complete! 
echo [+] All dependencies are now installed.
echo [+] You can now run the 'start_server.bat' script.
echo =======================================================
pause
