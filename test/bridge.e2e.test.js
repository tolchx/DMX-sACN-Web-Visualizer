'use strict';
/**
 * Test de integración del BRIDGE completo:
 *   Art-Net + sACN entran a la vez -> se unifican (HTP/LTP) -> salen como sACN o Art-Net.
 *
 * Ejecutar: node --test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const { createApp } = require('../server');
const dmx = require('../lib/dmx');

const HTTP_PORT = 3111;
const ARTNET_IN = 16454;
const SACN_IN = 15568;
const SACN_OUT = 6555;
const ARTNET_OUT = 6556;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app;

function slots(set = {}) {
    const buf = new Uint8Array(512);
    for (const [k, v] of Object.entries(set)) buf[Number(k)] = v;
    return buf;
}

function udpSender() {
    const sock = dgram.createSocket('udp4');
    return {
        artnet(universe, data) {
            const pkt = dmx.buildArtNetDmx(universe, data, 0);
            return new Promise((res) => sock.send(pkt, 0, pkt.length, ARTNET_IN, '127.0.0.1', res));
        },
        sacn(universe, data) {
            const pkt = dmx.buildSacn(universe, data, { cid: Buffer.alloc(16, 1) });
            return new Promise((res) => sock.send(pkt, 0, pkt.length, SACN_IN, '127.0.0.1', res));
        },
        close: () => sock.close(),
    };
}

function udpCollector(port) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const received = [];
    sock.on('message', (msg) => received.push(Buffer.from(msg)));
    return new Promise((resolve) => {
        sock.bind(port, '127.0.0.1', () => resolve({
            received,
            last: () => received[received.length - 1],
            clear: () => { received.length = 0; },
            close: () => sock.close(),
        }));
    });
}

function post(pathname, body) {
    return fetch(`http://127.0.0.1:${HTTP_PORT}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    }).then((r) => r.json());
}

function getJson(pathname) {
    return fetch(`http://127.0.0.1:${HTTP_PORT}${pathname}`).then((r) => r.json());
}

/** Último paquete de un universo concreto (evita leer restos de otros tests). */
function lastFor(collector, universe, parser) {
    const parse = parser || dmx.parseSacn;
    for (let i = collector.received.length - 1; i >= 0; i--) {
        const parsed = parse(collector.received[i]);
        if (parsed && parsed.universe === universe) return parsed;
    }
    return null;
}

/** Espera hasta que el colector reciba algo o se agote el tiempo. */
async function waitForPacket(collector, timeoutMs = 1500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (collector.received.length > 0) return true;
        await sleep(50);
    }
    return false;
}

before(async () => {
    app = createApp({ port: HTTP_PORT, artnetInPort: ARTNET_IN, sacnInPort: SACN_IN, verbose: false });
    await app.start();
    // sin multicast en los tests (más rápido y silencioso)
    await post('/api/config', {
        artnetIn: { enabled: true, interface: '0.0.0.0' },
        sacnIn: { enabled: true, interface: '0.0.0.0', joinMulticast: false },
        merge: { policy: 'htp', sources: 'both' },
        out: { protocol: 'sacn', targetMode: 'unicast', targetIp: '127.0.0.1', port: SACN_OUT, interface: '', rate: 30 },
        enabled: false,
        universeOffset: 0,
        mutedUniverses: [],
    });
    await post('/api/reset-stats');
});

after(async () => {
    await app.stop();
});

test('el bridge recibe Art-Net Y sACN a la vez (las dos entradas conviven)', async () => {
    const sender = udpSender();
    await sender.artnet(1, slots({ 0: 100 }));
    await sender.sacn(1, slots({ 0: 50 }));
    await sleep(250);

    const stats = await getJson('/api/stats');
    assert.ok(stats.stats.received.artnet >= 1, 'debe haber recibido Art-Net');
    assert.ok(stats.stats.received.sacn >= 1, 'debe haber recibido sACN');

    const cfg = await getJson('/api/config');
    assert.deepStrictEqual(cfg.config.artnetIn.enabled, true);
    assert.deepStrictEqual(cfg.config.sacnIn.enabled, true);
    sender.close();
});

test('HTP: la salida sACN lleva el valor más alto de las dos fuentes', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();

    await post('/api/config', {
        merge: { policy: 'htp', sources: 'both' },
        out: { protocol: 'sacn', targetMode: 'unicast', targetIp: '127.0.0.1', port: SACN_OUT },
        enabled: true,
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
        await sender.artnet(2, slots({ 0: 100, 1: 20 }));
        await sender.sacn(2, slots({ 0: 50, 1: 200 }));
        await sleep(60);
    }

    assert.ok(await waitForPacket(collector), 'el bridge debe estar emitiendo sACN');
    const parsed = lastFor(collector, 2);
    assert.ok(parsed, 'la salida debe ser un paquete sACN del universo 2');
    assert.strictEqual(parsed.data[0], 100, 'canal 1: HTP debe tomar 100 (Art-Net)');
    assert.strictEqual(parsed.data[1], 200, 'canal 2: HTP debe tomar 200 (sACN)');

    // El estado unificado también se ve en la API
    const cfg = await getJson('/api/config');
    assert.strictEqual(cfg.config.merge.policy, 'htp');

    collector.close();
    sender.close();
});

test('LTP: gana la fuente que llegó último (y la API lo refleja)', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();

    await post('/api/config', { merge: { policy: 'ltp', sources: 'both' }, enabled: true });

    // Art-Net primero, sACN 120ms después -> sACN debe ganar
    await sender.artnet(3, slots({ 0: 111 }));
    await sleep(120);
    await sender.sacn(3, slots({ 0: 33 }));
    await sleep(400);

    assert.ok(await waitForPacket(collector), 'el bridge debe emitir con LTP');
    const parsed = lastFor(collector, 3);
    assert.ok(parsed, 'debe haber salida del universo 3');
    assert.strictEqual(parsed.data[0], 33, 'LTP: gana sACN (llegó último)');

    // Ahora Art-Net llega último -> 111
    collector.clear();
    await sender.sacn(3, slots({ 0: 33 }));
    await sleep(120);
    await sender.artnet(3, slots({ 0: 111 }));
    await sleep(400);

    const parsed2 = lastFor(collector, 3);
    assert.strictEqual(parsed2.data[0], 111, 'LTP: ahora gana Art-Net');

    collector.close();
    sender.close();
});

test('salida en formato Art-Net (el bridge puede emitir por cualquiera de los dos protocolos)', async () => {
    const collector = await udpCollector(ARTNET_OUT);
    const sender = udpSender();
    collector.clear();

    await post('/api/config', {
        merge: { policy: 'htp', sources: 'both' },
        out: { protocol: 'artnet', targetMode: 'unicast', targetIp: '127.0.0.1', port: ARTNET_OUT },
        enabled: true,
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
        await sender.sacn(5, slots({ 2: 77 }));
        await sleep(60);
    }

    assert.ok(await waitForPacket(collector), 'el bridge debe emitir Art-Net');
    const parsed = lastFor(collector, 5, dmx.parseArtNetDmx);
    assert.ok(parsed, 'la salida debe ser un ArtDmx válido del universo 5');
    assert.strictEqual(parsed.data[2], 77);

    const stats = await getJson('/api/stats');
    assert.ok(stats.stats.sent.artnet >= 1, 'debe haber contado envíos Art-Net');

    collector.close();
    sender.close();
});

test('selector de fuentes: con "sacn" la entrada Art-Net se ignora', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();

    await post('/api/config', {
        merge: { policy: 'htp', sources: 'sacn' },
        out: { protocol: 'sacn', targetMode: 'unicast', targetIp: '127.0.0.1', port: SACN_OUT },
        enabled: true,
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
        await sender.artnet(6, slots({ 0: 255 }));
        await sender.sacn(6, slots({ 0: 10 }));
        await sleep(60);
    }

    assert.ok(await waitForPacket(collector));
    const parsed = lastFor(collector, 6);
    assert.strictEqual(parsed.data[0], 10, 'con sources=sacn debe ignorar Art-Net (255)');

    collector.close();
    sender.close();
});

test('offset de universo y universos silenciados se aplican a la salida', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();

    await post('/api/config', {
        universeOffset: 1,
        mutedUniverses: [9],
        merge: { policy: 'htp', sources: 'both' },
        out: { protocol: 'sacn', targetMode: 'unicast', targetIp: '127.0.0.1', port: SACN_OUT },
        enabled: true,
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
        await sender.sacn(8, slots({ 0: 42 })); // sale como universo 9 -> silenciado
        await sender.sacn(7, slots({ 0: 24 })); // sale como universo 8
        await sleep(60);
    }

    await sleep(200);
    const universos = new Set(collector.received.map((p) => dmx.parseSacn(p).universe));
    assert.ok(universos.has(8), 'el universo 7 + offset 1 debe salir como 8');
    assert.ok(!universos.has(9), 'el universo 8 + offset 1 = 9 está silenciado y no debe salir');

    collector.close();
    sender.close();
});
