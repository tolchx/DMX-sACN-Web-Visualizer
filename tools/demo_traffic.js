'use strict';
/**
 * demo_traffic.js — Generador de tráfico de prueba (Art-Net + sACN a la vez).
 *
 * Sirve para verificar el bridge SIN consola de luces:
 *   node tools/demo_traffic.js [--sacn-host 127.0.0.1] [--artnet-host 127.0.0.1] [--seconds 30]
 *
 * Manda:
 *   - Art-Net: universo 1 con un chaser en los primeros 24 canales (rojo/verde/azul en bloques)
 *   - sACN:    universo 1 con valores DISTINTOS (permite ver el HTP/LTP) y universo 2 con un barrido
 */

const dgram = require('dgram');
const dmx = require('../lib/dmx');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const SACN_HOST = argValue('--sacn-host', '127.0.0.1');
const ARTNET_HOST = argValue('--artnet-host', '127.0.0.1');
const SECONDS = parseInt(argValue('--seconds', '30'), 10);
const RATE = parseInt(argValue('--rate', '40'), 10);

const sock = dgram.createSocket('udp4');
const cid = Buffer.alloc(16, 7);
let tick = 0;

console.log(`[demo] Art-Net -> ${ARTNET_HOST}:${dmx.ARTNET_PORT} · sACN -> ${SACN_HOST}:${dmx.SACN_PORT}`);
console.log(`[demo] ${RATE} Hz durante ${SECONDS}s (Ctrl+C para cortar)`);

const timer = setInterval(() => {
    tick++;

    // --- Art-Net: universo 1, chaser de 24 canales (8 píxeles RGB) ---
    const aSlots = new Uint8Array(512);
    for (let px = 0; px < 8; px++) {
        const phase = (tick + px * 6) % 48;
        const level = phase < 24 ? 255 - (phase * 10) : 0;
        aSlots[px * 3] = Math.max(0, level);            // R
        aSlots[px * 3 + 1] = Math.max(0, 120 - phase);  // G
        aSlots[px * 3 + 2] = Math.max(0, 60 + phase);   // B
    }
    const artnetPacket = dmx.buildArtNetDmx(1, aSlots, tick & 0xff);
    sock.send(artnetPacket, 0, artnetPacket.length, dmx.ARTNET_PORT, ARTNET_HOST);

    // --- sACN: universo 1 con valores distintos (para ver el merge) ---
    const sSlots = new Uint8Array(512);
    for (let i = 0; i < 24; i++) sSlots[i] = (tick * 3 + i * 5) % 256;
    const sacn1 = dmx.buildSacn(1, sSlots, { cid, sequence: tick & 0xff });
    sock.send(sacn1, 0, sacn1.length, dmx.SACN_PORT, SACN_HOST);

    // --- sACN: universo 2, barrido simple ---
    const s2 = new Uint8Array(512);
    for (let i = 0; i < 48; i++) s2[i] = (i * 5 + tick * 2) % 256;
    const sacn2 = dmx.buildSacn(2, s2, { cid, sequence: tick & 0xff });
    sock.send(sacn2, 0, sacn2.length, dmx.SACN_PORT, SACN_HOST);

    if (tick % (RATE * 5) === 0) console.log(`[demo] ${tick} paquetes por fuente enviados`);
}, Math.round(1000 / RATE));

setTimeout(() => {
    clearInterval(timer);
    sock.close();
    console.log('[demo] fin');
    process.exit(0);
}, SECONDS * 1000);
