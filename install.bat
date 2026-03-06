@echo off
color 0A
title DMX Web Visualizer - Installer

echo =======================================================
echo DMX / sACN Web Visualizer ^& Bridge - Install Target
echo =======================================================
echo.
echo Checking for Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Node.js is not installed on this system!
    echo Attempting to install Node.js automatically via Windows Package Manager (winget)...
    
    :: Try installing via winget
    winget install OpenJS.NodeJS -e --accept-source-agreements --accept-package-agreements
    
    if %errorlevel% neq 0 (
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
echo Installing required dependencies (express, socket.io)...
echo.
call npm install
echo.
echo =======================================================
echo [+] Installation Complete! 
echo [+] You can now run the 'start_server.bat' script.
echo =======================================================
pause
