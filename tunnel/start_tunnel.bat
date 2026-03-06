@echo off
echo ==========================================
echo       Starting sACN Internet Tunnel
echo ==========================================
echo.
echo If this is your first time, make sure you ran install_tunnel.bat first!
echo.
echo Starting Tunnel Server...
start "" http://localhost:3001
node server.js
pause
