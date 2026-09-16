# Descarga el runtime portatil de Node.js dentro de runtime\ (no instala nada en el sistema).
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\descargar_runtime.ps1 [-ConNpm]

param(
    [switch]$ConNpm
)

$ErrorActionPreference = "Stop"
$raiz = Split-Path -Parent $PSScriptRoot          # carpeta del proyecto
$destino = Join-Path $raiz "runtime"
$version = "v22.17.1"                              # version estable usada en desarrollo
$url = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"

Write-Host "  -> Descargando Node $version (portatil) desde nodejs.org ..." -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP "node-portable-$version.zip"

try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
    Write-Host "  [ERROR] No se pudo descargar: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "  -> Descomprimiendo..." -ForegroundColor Cyan
$extraer = Join-Path $env:TEMP "node-portable-$version"
if (Test-Path $extraer) { Remove-Item $extraer -Recurse -Force }
Expand-Archive -Path $tmp -DestinationPath $extraer -Force

$origen = Join-Path $extraer "node-$version-win-x64"
New-Item -ItemType Directory -Force -Path $destino | Out-Null

# node.exe es lo unico imprescindible para CORRER el server
Copy-Item (Join-Path $origen "node.exe") $destino -Force
foreach ($extra in @("LICENSE", "README.md", "CHANGELOG.md")) {
    $f = Join-Path $origen $extra
    if (Test-Path $f) { Copy-Item $f $destino -Force }
}

# npm solo hace falta para instalar dependencias cuando no vienen incluidas
if ($ConNpm) {
    Write-Host "  -> Copiando npm (para instalar dependencias)..." -ForegroundColor Cyan
    $items = @("npm", "npm.cmd", "npx", "npx.cmd", "node_modules")
    foreach ($item in $items) {
        $src = Join-Path $origen $item
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $destino $item) -Recurse -Force
        }
    }
    # npm busca sus modulos en runtime\node_modules
    $nm = Join-Path $origen "node_modules"
    if (Test-Path $nm) { Copy-Item $nm (Join-Path $destino "node_modules") -Recurse -Force }
}

Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Remove-Item $extraer -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path (Join-Path $destino "node.exe")) {
    $mb = [math]::Round((Get-Item (Join-Path $destino "node.exe")).Length / 1MB, 1)
    Write-Host "  [OK] Runtime listo: runtime\node.exe ($mb MB)" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  [ERROR] No se encontro node.exe despues de descomprimir." -ForegroundColor Red
    exit 1
}
