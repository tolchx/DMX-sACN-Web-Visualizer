#!/usr/bin/env bash
# Publica la v2.0 del bridge: dos entradas con selección de placa, unificación HTP/LTP y salida en ambos protocolos.
set -u
cd /c/Users/Tolch/Documents/AI_Code/DMX_to_sACN/web-visualizer || exit 1

rm -f tools/update_app_js.py   # script de migración de un solo uso

git add -A server.js lib public package.json README.md test tools bridge-sections.css 2>/dev/null
git add -A 2>/dev/null

echo "=== a commitear ==="
git status --short | head -20

git -c user.name=tolchx -c user.email=tolchx@gmail.com commit -q -F - <<'MSG'
feat(bridge): dos entradas (Art-Net + sACN) con placa elegible, unificación HTP/LTP y salida en ambos protocolos

Entradas
- Art-Net (UDP 6454) y sACN (UDP 5568) con su PROPIA placa de red seleccionable.
- Las dos pueden escuchar la misma placa a la vez (puertos distintos).
- sACN ahora une los grupos multicast de un rango de universos configurable
  (recibe multicast y unicast) en la placa elegida.
- Se corrige el filtro de placa de Art-Net: antes comparaba la IP del EMISOR
  (rinfo.address) en lugar de enlazar la placa receptora -> mostraba tráfico de
  todas las placas. Ahora el socket se enlaza de verdad a la placa elegida.

Unificación
- Estado unificado por universo de las dos entradas, con modo HTP (valor más alto
  por canal, por defecto) o LTP (gana la fuente más reciente), y selector de fuentes.

Salida
- Formato elegible: sACN o Art-Net DMX (se arma el paquete ArtDmx completo).
- Placa, destino (multicast / unicast / broadcast), puerto y frecuencia configurables.
- Se mantiene offset de universo, universos silenciados y presets (compatibles con
  los guardados en la v1 mediante normalizeConfig).

UI
- Panel reorganizado en secciones: Entrada 1 Art-Net, Entrada 2 sACN, Unificación, Salida.
- Tercera vista "Unified" en el visor + indicador de fuentes y de quién gana por universo.
- Bloque de estado del bridge (paquetes in/out, placas en uso, grupos multicast, errores).
- Deep-link http://localhost:3000/#bridge. Corrección: los listeners viejos de los
  radios eliminados rompían el registro del resto de los handlers de socket.io.

Tests y herramientas
- lib/dmx.js: codec y merge como módulo puro.
- test/dmx.test.js (unit) + test/bridge.e2e.test.js (integración UDP real:
  entra Art-Net y sACN juntos, se unifican y salen en sACN y en Art-Net). 18/18.
- tools/demo_traffic.js: genera tráfico de los dos protocolos para probar sin consola.
- API REST: GET/POST /api/config, GET /api/stats, POST /api/reset-stats.
MSG

echo
echo "=== push ==="
git push origin HEAD 2>&1 | tail -3
echo
echo "local : $(git rev-parse HEAD)"
echo "remoto: $(git rev-parse origin/$(git rev-parse --abbrev-ref HEAD) 2>/dev/null)"
echo "estado: $(git status --short | wc -l) archivos pendientes"
