'use strict';
/**
 * Test de integración del BRIDGE v2.1:
 *   dos entradas genéricas (cada una elige protocolo y placa) → unificación → salida.
 *   Incluye el silenciado POR ENTRADA (pedido de Facundo).
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
        artnet(universe, data, port = ARTNET_IN) {
            const pkt = dmx.buildArtNetDmx(universe, data, 0);
            return new Promise((res) => sock.send(pkt, 0, pkt.length, port, '127.0.0.1', res));
        },
        sacn(universe, data, port = SACN_IN) {
            const pkt = dmx.buildSacn(universe, data, { cid: Buffer.alloc(16, 1) });
            return new Promise((res) => sock.send(pkt, 0, pkt.length, port, '127.0.0.1', res));
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
            clear: () => { received.length = 0; },
            close: () => sock.close(),
        }));
    });
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

async function waitForPacket(collector, timeoutMs = 1500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (collector.received.length > 0) return true;
        await sleep(50);
    }
    return false;
}

/** Configura las dos entradas genéricas + la salida. */
function setConfig(extra = {}) {
    const body = Object.assign({
        inputs: [
            { protocol: 'artnet', enabled: true, interface: '0.0.0.0' },
            { protocol: 'sacn', enabled: true, interface: '0.0.0.0', joinMulticast: false },
        ],
        merge: { sources: 'both' },
        out: { protocol: 'sacn', targetMode: 'unicast', targetIp: '127.0.0.1', port: SACN_OUT, interface: '', rate: 30 },
        universeOffset: 0,
        enabled: false,
    }, extra);
    return fetch(`http://127.0.0.1:${HTTP_PORT}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then((r) => r.json());
}

const getJson = (p) => fetch(`http://127.0.0.1:${HTTP_PORT}${p}`).then((r) => r.json());
const post = (p, body) => fetch(`http://127.0.0.1:${HTTP_PORT}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
}).then((r) => r.json());

before(async () => {
    app = createApp({ port: HTTP_PORT, artnetInPort: ARTNET_IN, sacnInPort: SACN_IN, verbose: false });
    await app.start();
    await setConfig();
    await post('/api/reset-stats');
});

after(async () => {
    await app.stop();
});

test('las dos entradas reciben a la vez (entrada 1 Art-Net, entrada 2 sACN)', async () => {
    const sender = udpSender();
    await sender.artnet(1, slots({ 0: 100 }));
    await sender.sacn(1, slots({ 0: 50 }));
    await sleep(250);

    const stats = (await getJson('/api/stats')).stats;
    assert.ok(stats.received[0].paquetes >= 1, 'la entrada 1 debe recibir Art-Net');
    assert.ok(stats.received[1].paquetes >= 1, 'la entrada 2 debe recibir sACN');
    sender.close();
});

test('las entradas se pueden INVERTIR: entrada 1 sACN y entrada 2 Art-Net', async () => {
    await setConfig({
        inputs: [
            { protocol: 'sacn', enabled: true, interface: '0.0.0.0', joinMulticast: false },
            { protocol: 'artnet', enabled: true, interface: '0.0.0.0' },
        ],
    });
    await post('/api/reset-stats');

    const sender = udpSender();
    for (let i = 0; i < 4; i++) {
        await sender.sacn(20, slots({ 0: 11 }));
        await sender.artnet(20, slots({ 1: 22 }));
        await sleep(50);
    }
    await sleep(250);

    const stats = (await getJson('/api/stats')).stats;
    assert.ok(stats.received[0].paquetes >= 1, 'la entrada 1 (ahora sACN) debe recibir');
    assert.ok(stats.received[1].paquetes >= 1, 'la entrada 2 (ahora Art-Net) debe recibir');

    const cfg = await getJson('/api/config');
    assert.strictEqual(cfg.config.inputs[0].protocol, 'sacn');
    assert.strictEqual(cfg.config.inputs[1].protocol, 'artnet');

    sender.close();
    await setConfig(); // volver a la config por defecto
});

test('HTP: la salida lleva el valor más alto de las dos entradas', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();
    await setConfig({ enabled: true });

    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
        await sender.artnet(2, slots({ 0: 100, 1: 20 }));
        await sender.sacn(2, slots({ 0: 50, 1: 200 }));
        await sleep(60);
    }

    assert.ok(await waitForPacket(collector), 'el bridge debe estar emitiendo');
    const parsed = lastFor(collector, 2);
    assert.ok(parsed, 'debe haber salida del universo 2');
    assert.strictEqual(parsed.data[0], 100, 'canal 1: HTP toma 100 (entrada 1)');
    assert.strictEqual(parsed.data[1], 200, 'canal 2: HTP toma 200 (entrada 2)');

    collector.close();
    sender.close();
});

test('SILENCIADO POR ENTRADA: silenciar el universo en la entrada 1 deja pasar la entrada 2', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();
    await setConfig({ enabled: true });
    await post('/api/reset-stats');

    // antes de silenciar: HTP toma el mayor (255 de la entrada 1)
    let t0 = Date.now();
    while (Date.now() - t0 < 800) {
        await sender.artnet(4, slots({ 0: 255 }));
        await sender.sacn(4, slots({ 0: 10 }));
        await sleep(60);
    }
    let parsed = lastFor(collector, 4);
    assert.strictEqual(parsed.data[0], 255, 'sin silenciar, gana el mayor');

    // silenciamos el universo 4 EN LA ENTRADA 1
    const r = await post('/api/mute', { input: 0, universe: 4 });
    assert.strictEqual(r.muted, true);

    collector.clear();
    t0 = Date.now();
    while (Date.now() - t0 < 900) {
        await sender.artnet(4, slots({ 0: 255 }));  // entrada 1: debe ser ignorada
        await sender.sacn(4, slots({ 0: 10 }));
        await sleep(60);
    }

    parsed = lastFor(collector, 4);
    assert.ok(parsed, 'el universo sigue saliendo (lo alimenta la entrada 2)');
    assert.strictEqual(parsed.data[0], 10, 'con la entrada 1 silenciada, la salida queda limpia con 10');

    const stats = (await getJson('/api/stats')).stats;
    assert.ok(stats.droppedMuted[0] >= 1, 'los paquetes de la entrada 1 silenciada se descartan');

    // limpiar el silenciado
    await post('/api/mute', { input: 0, universe: 4 });
    collector.close();
    sender.close();
});

test('silenciar en la entrada 2 no afecta a la entrada 1', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();
    await setConfig({ enabled: true });

    await post('/api/mute', { input: 1, universe: 6 });

    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
        await sender.artnet(6, slots({ 0: 200 }));
        await sender.sacn(6, slots({ 0: 30 }));   // silenciado en la entrada 2
        await sleep(60);
    }

    const parsed = lastFor(collector, 6);
    assert.ok(parsed);
    assert.strictEqual(parsed.data[0], 200, 'sólo llega la entrada 1 (la 2 está silenciada para ese universo)');

    await post('/api/mute', { input: 1, universe: 6 });
    collector.close();
    sender.close();
});

test('salida en formato Art-Net (el bridge emite en cualquiera de los dos protocolos)', async () => {
    const collector = await udpCollector(ARTNET_OUT);
    const sender = udpSender();
    collector.clear();

    await setConfig({
        enabled: true,
        out: { protocol: 'artnet', targetMode: 'unicast', targetIp: '127.0.0.1', port: ARTNET_OUT },
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
        await sender.sacn(5, slots({ 2: 77 }));
        await sleep(60);
    }

    assert.ok(await waitForPacket(collector), 'debe emitir Art-Net');
    const parsed = lastFor(collector, 5, dmx.parseArtNetDmx);
    assert.ok(parsed, 'la salida debe ser un ArtDmx válido del universo 5');
    assert.strictEqual(parsed.data[2], 77);

    collector.close();
    sender.close();
    await setConfig(); // restaurar salida sACN
});

test('selector de fuentes: con "input2" la entrada 1 se ignora', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();
    await setConfig({ enabled: true, merge: { sources: 'input2' } });

    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
        await sender.artnet(7, slots({ 0: 255 }));   // entrada 1: ignorada por la unificación
        await sender.sacn(7, slots({ 0: 10 }));
        await sleep(60);
    }

    assert.ok(await waitForPacket(collector));
    const parsed = lastFor(collector, 7);
    assert.strictEqual(parsed.data[0], 10, 'con sources=input2 sólo pasa la entrada 2');

    collector.close();
    sender.close();
    await setConfig({ merge: { sources: 'both' } });
});

test('offset de universo se aplica a la salida', async () => {
    const collector = await udpCollector(SACN_OUT);
    const sender = udpSender();
    collector.clear();
    await setConfig({ enabled: true, universeOffset: 1 });

    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
        await sender.sacn(7, slots({ 0: 24 }));
        await sleep(60);
    }
    await sleep(200);

    const universos = new Set(collector.received.map((p) => dmx.parseSacn(p).universe));
    assert.ok(universos.has(8), 'el universo 7 + offset 1 debe salir como 8');

    collector.close();
    sender.close();
    await setConfig({ universeOffset: 0 });
});
