@echo off
title DMX Web Visualizer Local Server
color 0B

echo =======================================================
echo Starting DMX / sACN Web Visualizer Server...
echo =======================================================
echo.

:: Check if node_modules exists
if not exist node_modules\ (
    echo [ERROR] 'node_modules' folder not found!
    echo It looks like you haven't installed dependencies yet.
    echo Please run 'install.bat' first.
    echo.
    pause
    exit
)

:: Start the Node.js server in a separate background/minimized process 
:: or just run it in this window. Running in this window is better so the user can close it easily.
start "DMX Backend Server" cmd /k "node server.js"

echo [+] Server started!
echo [+] Waiting 2 seconds for backend to initialize...
timeout /t 2 /nobreak >nul

echo [+] Opening Web Browser at http://localhost:3000...
start http://localhost:3000

echo.
echo You can minimize this window.
echo To stop the server, close the 'DMX Backend Server' CMD window.
exit
