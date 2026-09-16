#!/usr/bin/env bash
# v2.0 como main + la versión anterior guardada como rama v1-legacy (con tags).
set -u
cd /c/Users/Tolch/Documents/AI_Code/DMX_to_sACN/web-visualizer || exit 1

OLD=429ced6   # último commit de la versión anterior (main previo a la v2)

echo "=== 1) screenshots nuevos para el README (la UI del panel cambió) ==="
cp -f "/c/Users/Tolch/AppData/Local/Temp/final_ui_visor.png" assets/screenshot-grid.png
cp -f "/c/Users/Tolch/AppData/Local/Temp/final_ui_panel.png" assets/screenshot-modal.png
ls -la assets/*.png | awk '{print "  ", $5, $9}'

echo
echo "=== 2) commit de los assets ==="
git add assets/screenshot-grid.png assets/screenshot-modal.png
git -c user.name=tolchx -c user.email=tolchx@gmail.com commit -q -m "docs(assets): capturas actualizadas de la v2 (vista Unified y panel de dos entradas)" || echo "  (nada para commitear)"
git log --oneline -1

echo
echo "=== 3) guardar la versión anterior como rama ==="
git branch -f v1-legacy "$OLD"
echo "  rama v1-legacy -> $(git rev-parse --short v1-legacy)"

echo
echo "=== 4) tags ==="
git tag -f v1.0 "$OLD" >/dev/null
git tag -f v2.0 HEAD >/dev/null
echo "  v1.0 -> $(git rev-parse --short v1.0) · v2.0 -> $(git rev-parse --short v2.0)"

echo
echo "=== 5) push de todo ==="
git push origin main 2>&1 | tail -2
git push origin v1-legacy 2>&1 | tail -2
git push --force origin refs/tags/v1.0 refs/tags/v2.0 2>&1 | tail -2

echo
echo "=== 6) verificación del remoto (real, no local) ==="
git fetch -q origin
echo "  main (local) : $(git rev-parse HEAD)"
echo "  main (remoto): $(git rev-parse origin/main)"
echo "  v1-legacy    : $(git rev-parse origin/v1-legacy 2>/dev/null)"
echo "  archivos pendientes: $(git status --short | wc -l)"
echo
echo "=== 7) ramas y tags en el remoto ==="
git ls-remote --heads --tags origin | sed 's|.*refs/|  refs/|'
