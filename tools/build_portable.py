# -*- coding: utf-8 -*-
"""
build_portable.py — Arma los paquetes PORTABLES (no requieren instalar Node.js).

Genera en dist/:
  · DMX-SACN Web Visualizer <version> Portable.zip   (rama main / v2)
  · DMX-SACN Web Visualizer 1.0 Portable.zip         (rama v1-legacy: la que ya funciona)

Cada paquete contiene: código + node_modules + runtime\\node.exe + los .bat portables.
Se copia la carpeta a otra PC y se hace doble clic en start_server.bat.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(RAIZ, "dist")

# OJO: excluir solo en la RAIZ del proyecto. Excluir cualquier carpeta llamada "dist"
# rompe node_modules (path-to-regexp/dist, express, etc. lo necesitan).
EXCLUIR_TOP = {".git", "dist", ".trae", ".vscode", ".idea"}
EXCLUIR_SIEMPRE = {"__pycache__", ".cache", ".turbo"}
EXCLUIR_EXT = {".zip", ".rar", ".7z", ".log", ".mp4", ".toe", ".bak"}

LEEME = """DMX / sACN Web Visualizer & Bridge — version PORTABLE
=========================================================

QUE HACER
  1. Copia esta carpeta ENTERA a la PC donde la vayas a usar (no hace falta internet).
  2. Doble clic en  start_server.bat
  3. Se abre solo el panel en el navegador: http://localhost:3000

NO HAY QUE INSTALAR NADA
  - El runtime de Node ya viene dentro (carpeta runtime/).
  - Las dependencias ya vienen dentro (carpeta node_modules/).
  - No se instala ni se modifica nada en el sistema.

SI ALGO NO ARRANCA
  - Verifica que las carpetas 'runtime' y 'node_modules' esten completas
    (algunos programas de compresion cortan archivos grandes: usa la opcion "Extraer todo").
  - Ejecuta install.bat: revisa/descarga lo que falte, siempre dentro de esta carpeta.
  - El puerto 3000 lo tiene que tener libre.

PUERTOS QUE USA
  - 3000  panel web            (http://localhost:3000)
  - 6454  entrada Art-Net DMX
  - 5568  entrada sACN (E1.31)

CONSEJO: si Windows o el antivirus pide permiso de red, dale permiso
(es para poder escuchar el DMX que llega por la red).
"""


def info(msg):
    print(msg, flush=True)


def excluido(ruta_rel, es_raiz=False):
    partes = ruta_rel.replace("/", "\\").split("\\")
    if es_raiz and partes[0] in EXCLUIR_TOP:
        return True
    if any(p in EXCLUIR_SIEMPRE for p in partes):
        return True
    if os.path.splitext(ruta_rel)[1].lower() in EXCLUIR_EXT:
        return True
    return False


def copiar_arbol(origen, destino):
    """Copia respetando las exclusiones (sin .git, sin zips, etc.)."""
    n = 0
    for raiz, dirs, files in os.walk(origen):
        es_raiz = os.path.abspath(raiz) == os.path.abspath(origen)
        dirs[:] = [d for d in dirs
                   if not excluido(os.path.relpath(os.path.join(raiz, d), origen), es_raiz)]
        for f in files:
            rel = os.path.relpath(os.path.join(raiz, f), origen)
            if excluido(rel, es_raiz):
                continue
            dst = os.path.join(destino, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(raiz, f), dst)
            n += 1
    return n


def zip_dir(origen, zip_path):
    total = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for raiz, dirs, files in os.walk(origen):
            for f in files:
                p = os.path.join(raiz, f)
                z.write(p, os.path.relpath(p, os.path.dirname(origen)))
                total += os.path.getsize(p)
    return total


def version_de(rama=None):
    if rama:
        raw = subprocess.run(["git", "show", f"{rama}:package.json"], cwd=RAIZ,
                             capture_output=True, text=True).stdout
    else:
        with open(os.path.join(RAIZ, "package.json"), encoding="utf-8") as fh:
            raw = fh.read()
    try:
        return json.loads(raw).get("version", "0.0.0")
    except Exception:
        return "0.0.0"


def armar(destino, portatil_bats=True):
    """Copia el proyecto al staging y asegura runtime + node_modules + .bat portables."""
    os.makedirs(destino, exist_ok=True)

    # 1) runtime portatil (obligatorio: es lo que evita instalar Node)
    runtime_src = os.path.join(RAIZ, "runtime")
    if not os.path.isfile(os.path.join(runtime_src, "node.exe")):
        info("  [ERROR] falta runtime\\node.exe — corre primero install.bat")
        return False
    runtime_dst = os.path.join(destino, "runtime")
    os.makedirs(runtime_dst, exist_ok=True)
    for f in os.listdir(runtime_src):
        src = os.path.join(runtime_src, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(runtime_dst, f))
    info(f"  runtime: {len(os.listdir(runtime_dst))} archivos "
         f"({os.path.getsize(os.path.join(runtime_dst, 'node.exe')) / 1e6:.0f} MB node.exe)")

    # 2) dependencias
    nm_src = os.path.join(RAIZ, "node_modules")
    nm_dst = os.path.join(destino, "node_modules")
    if os.path.isdir(nm_src):
        n = copiar_arbol(nm_src, nm_dst)
        info(f"  node_modules: {n} archivos")

    # 3) .bat portables (en la v1 el bat viejo esperaba Node del sistema)
    if portatil_bats:
        for bat in ("start_server.bat", "install.bat"):
            shutil.copy2(os.path.join(RAIZ, bat), os.path.join(destino, bat))
        os.makedirs(os.path.join(destino, "tools"), exist_ok=True)
        shutil.copy2(os.path.join(RAIZ, "tools", "descargar_runtime.ps1"),
                     os.path.join(destino, "tools", "descargar_runtime.ps1"))
        info("  .bat portables inyectados")

    # 4) instrucciones
    with open(os.path.join(destino, "LEEME-PRIMERO.txt"), "w", encoding="utf-8") as fh:
        fh.write(LEEME)
    return True


def construir_v2():
    version = version_de()
    nombre = f"DMX-SACN Web Visualizer {version} Portable"
    info(f"\n=== v2 ({version}) desde el árbol de trabajo ===")
    with tempfile.TemporaryDirectory() as tmp:
        staging = os.path.join(tmp, nombre)
        n = copiar_arbol(RAIZ, staging)
        info(f"  proyecto: {n} archivos")
        if not armar(staging):
            return None
        zpath = os.path.join(DIST, f"{nombre}.zip")
        crudo = zip_dir(staging, zpath)
        return zpath, crudo


def construir_v1(rama="v1-legacy"):
    version = version_de(rama)
    nombre = f"DMX-SACN Web Visualizer {version} Portable"
    info(f"\n=== v1 ({version}) desde la rama {rama} ===")
    with tempfile.TemporaryDirectory() as tmp:
        # exporta SOLO lo versionado de la rama (sin .git)
        zip_rama = os.path.join(tmp, "rama.zip")
        subprocess.run(["git", "archive", "--format=zip", f"-o{zip_rama}", rama], cwd=RAIZ, check=True)
        staging = os.path.join(tmp, nombre)
        os.makedirs(staging, exist_ok=True)
        with zipfile.ZipFile(zip_rama) as z:
            z.extractall(staging)
        info(f"  proyecto (rama): {sum(len(f) for _, _, f in os.walk(staging))} archivos")
        if not armar(staging, portatil_bats=True):
            return None
        zpath = os.path.join(DIST, f"{nombre}.zip")
        crudo = zip_dir(staging, zpath)
        return zpath, crudo


if __name__ == "__main__":
    os.makedirs(DIST, exist_ok=True)
    resultados = []
    for fn in (construir_v2, construir_v1):
        r = fn()
        if r:
            resultados.append(r)

    print("\n=== RESULTADO ===")
    for zpath, crudo in resultados:
        print(f"  {os.path.basename(zpath)}")
        print(f"    {os.path.getsize(zpath) / 1e6:.1f} MB comprimido  (contenido: {crudo / 1e6:.1f} MB)")
        with zipfile.ZipFile(zpath) as z:
            malos = z.testzip()
            print(f"    integridad zip: {'OK' if malos is None else 'CORRUPTO en ' + str(malos)}")
