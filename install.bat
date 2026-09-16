@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title DMX Web Visualizer - Instalador (portatil)
color 0A

echo =======================================================
echo   Instalador - DMX / sACN Web Visualizer ^& Bridge
echo =======================================================
echo.
echo No instala NADA en el sistema: todo queda dentro de esta carpeta.
echo.

:: ---------------------------------------------------------------------------
:: 1) Runtime portatil de Node
:: ---------------------------------------------------------------------------
if exist "runtime\node.exe" (
    echo [+] Runtime portatil ya incluido: runtime\node.exe
) else (
    echo [i] No hay runtime portatil. Descargando desde nodejs.org ...
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\descargar_runtime.ps1"
    echo.
    if not exist "runtime\node.exe" (
        echo [ERROR] No se pudo descargar el runtime portatil.
        echo         Revisa la conexion a internet y volve a intentar.
        echo.
        pause
        exit /b 1
    )
)

:: ---------------------------------------------------------------------------
:: 2) Dependencias (express + socket.io)
:: ---------------------------------------------------------------------------
if exist "node_modules\express" (
    echo [+] Dependencias ya incluidas: node_modules\
) else (
    echo [i] Faltan las dependencias. Instalando con el runtime portatil...
    echo.
    set "NPMJS=%~dp0runtime\node_modules\npm\bin\npm-cli.js"
    if exist "!NPMJS!" (
        "%~dp0runtime\node.exe" "!NPMJS!" install --no-audit --no-fund
    ) else (
        echo     El runtime no incluye npm: descargando la distribucion completa...
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\descargar_runtime.ps1" -ConNpm
        if exist "!NPMJS!" (
            "%~dp0runtime\node.exe" "!NPMJS!" install --no-audit --no-fund
        ) else (
            where npm >nul 2>nul
            if errorlevel 1 (
                echo.
                echo [ERROR] No hay npm disponible para instalar las dependencias.
                echo         Copia el proyecto completo (con la carpeta node_modules)
                echo         desde la PC de origen.
                echo.
                pause
                exit /b 1
            )
            call npm install --no-audit --no-fund
        )
    )
    if errorlevel 1 (
        echo.
        echo [ERROR] Fallo la instalacion de dependencias.
        echo         Copia la carpeta node_modules desde la PC de origen.
        echo.
        pause
        exit /b 1
    )
    echo [+] Dependencias instaladas.
)

echo.
echo =======================================================
echo  [OK] Todo listo.
echo       Ejecuta start_server.bat (doble clic) y se abre
echo       el panel en http://localhost:3000
echo =======================================================
echo.
pause
