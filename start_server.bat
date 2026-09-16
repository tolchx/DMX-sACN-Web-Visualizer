@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title DMX / sACN Visualizer ^& Bridge - SERVIDOR (no cerrar esta ventana)
color 0B

echo =======================================================
echo   DMX / sACN Web Visualizer ^& Bridge
echo =======================================================
echo.

:: ---------------------------------------------------------------------------
:: 1) Node: se usa el runtime PORTATIL que viene en la carpeta (runtime\node.exe)
::    Asi NO hace falta tener Node.js instalado en esta PC.
:: ---------------------------------------------------------------------------
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" (
    echo [i] No encuentro runtime\node.exe en esta carpeta.
    echo     Uso el Node.js del sistema...
    set "NODE=node"
    where node >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [ERROR] No hay Node.js disponible.
        echo         Ejecuta install.bat: deja el runtime portatil dentro de esta
        echo         carpeta, sin instalar nada en el sistema.
        echo.
        goto :fin_error
    )
)

:: ---------------------------------------------------------------------------
:: 2) Dependencias incluidas en la carpeta
:: ---------------------------------------------------------------------------
if not exist "node_modules\express" (
    echo [ERROR] Falta la carpeta node_modules ^(las dependencias^).
    echo         Ejecuta install.bat una vez.
    echo.
    goto :fin_error
)

echo [+] Runtime: %NODE%
echo [+] Panel web:  http://localhost:3000
echo [+] Escuchando: Art-Net UDP 6454  ·  sACN UDP 5568
echo.
echo -------------------------------------------------------
echo  El servidor corre EN ESTA VENTANA.
echo  Para detenerlo: cerra esta ventana o apreta Ctrl+C.
echo -------------------------------------------------------
echo.

:: Abre el navegador 3 segundos despues (cuando el server ya esta escuchando)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"

:: El servidor corre en primer plano: si falla, el error se ve aca mismo
"%NODE%" "%~dp0server.js"

echo.
echo [i] El servidor se detuvo.
goto :fin_error

:fin_error
echo.
echo Presiona una tecla para cerrar...
pause >nul 2>nul
exit /b 0
