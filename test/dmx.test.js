'use strict';
/**
 * Tests unitarios del codec Art-Net/sACN y de la unificación (HTP/LTP).
 * Ejecutar: node --test
 */
const { test } = require('node:test');
const assert = require('node:assert');

const dmx = require('../lib/dmx');

test('Art-Net: build -> parse round-trip conserva universo y datos', () => {
    const slots = new Uint8Array(512);
    slots[0] = 255;
    slots[10] = 128;
    const packet = dmx.buildArtNetDmx(7, slots, 3, 0);

    assert.strictEqual(packet.length, 18 + 512);
    assert.strictEqual(packet.toString('ascii', 0, 7), 'Art-Net');
    assert.strictEqual(packet.readUInt16LE(8), 0x5000);

    const parsed = dmx.parseArtNetDmx(packet);
    assert.ok(parsed, 'debe parsear el paquete generado');
    assert.strictEqual(parsed.universe, 7);
    assert.strictEqual(parsed.data[0], 255);
    assert.strictEqual(parsed.data[10], 128);
});

test('Art-Net: universo alto usa Net + SubUni (port address 15 bits)', () => {
    const packet = dmx.buildArtNetDmx(600, new Uint8Array(512));
    assert.strictEqual(packet.readUInt8(14), 600 & 0xff); // SubUni
    assert.strictEqual(packet.readUInt8(15), 600 >> 8);   // Net
    assert.strictEqual(dmx.parseArtNetDmx(packet).universe, 600);
});

test('Art-Net: rechaza paquetes que no son ArtDmx', () => {
    assert.strictEqual(dmx.parseArtNetDmx(Buffer.from('basura basura basura')), null);
    const poll = dmx.buildArtNetDmx(1, new Uint8Array(512));
    poll.writeUInt16LE(0x2000, 8); // ArtPoll en vez de ArtDmx
    assert.strictEqual(dmx.parseArtNetDmx(poll), null);
});

test('sACN: build -> parse round-trip (638 bytes, universo big endian)', () => {
    const slots = new Uint8Array(512);
    slots[4] = 77;
    const packet = dmx.buildSacn(3, slots, { cid: Buffer.alloc(16, 9), sequence: 5, priority: 120 });

    assert.strictEqual(packet.length, 638);
    assert.strictEqual(packet.toString('ascii', 4, 16), 'ASC-E1.17\u0000\u0000\u0000');
    assert.strictEqual(packet.readUInt8(108), 120); // priority

    const parsed = dmx.parseSacn(packet);
    assert.ok(parsed);
    assert.strictEqual(parsed.universe, 3);
    assert.strictEqual(parsed.data[4], 77);
    assert.strictEqual(parsed.sequence, 5);
});

test('sACN: ignora paquetes de sincronización (start code != 0)', () => {
    const packet = dmx.buildSacn(1, new Uint8Array(512));
    packet.writeUInt8(0xcc, 125); // E1.31 sync
    assert.strictEqual(dmx.parseSacn(packet), null);
});

test('multicast sACN: universo -> 239.255.<hi>.<lo>', () => {
    assert.strictEqual(dmx.sacnMulticastIp(1), '239.255.0.1');
    assert.strictEqual(dmx.sacnMulticastIp(300), '239.255.1.44');
    assert.deepStrictEqual(dmx.sacnMulticastGroups(1, 3), ['239.255.0.1', '239.255.0.2', '239.255.0.3']);
});

test('unificación HTP: gana el valor más alto canal por canal', () => {
    const a = new Uint8Array(512); a[0] = 100; a[1] = 10;
    const s = new Uint8Array(512); s[0] = 50;  s[1] = 200;
    const merged = dmx.mergeUniverse({ data: a, ts: 1 }, { data: s, ts: 2 }, 'htp', 'both');

    assert.strictEqual(merged.data[0], 100);
    assert.strictEqual(merged.data[1], 200);
    assert.strictEqual(merged.winner, 'mix');
    assert.deepStrictEqual(merged.present.sort(), ['artnet', 'sacn']);
});

test('unificación LTP: gana la fuente más reciente (universo completo)', () => {
    const a = new Uint8Array(512); a[0] = 100;
    const s = new Uint8Array(512); s[0] = 50;

    const newerSacn = dmx.mergeUniverse({ data: a, ts: 10 }, { data: s, ts: 20 }, 'ltp', 'both');
    assert.strictEqual(newerSacn.data[0], 50);
    assert.strictEqual(newerSacn.winner, 'sacn');

    const newerArtnet = dmx.mergeUniverse({ data: a, ts: 30 }, { data: s, ts: 20 }, 'ltp', 'both');
    assert.strictEqual(newerArtnet.data[0], 100);
    assert.strictEqual(newerArtnet.winner, 'artnet');
});

test('unificación: con una sola fuente pasa tal cual', () => {
    const a = new Uint8Array(512); a[7] = 42;
    const only = dmx.mergeUniverse({ data: a, ts: 1 }, undefined, 'htp', 'both');
    assert.strictEqual(only.data[7], 42);
    assert.strictEqual(only.winner, 'artnet');
});

test('unificación: el selector de fuentes filtra la entrada ignorada', () => {
    const a = new Uint8Array(512); a[0] = 255;
    const s = new Uint8Array(512); s[0] = 10;

    const onlySacn = dmx.mergeUniverse({ data: a, ts: 5 }, { data: s, ts: 5 }, 'htp', 'sacn');
    assert.strictEqual(onlySacn.data[0], 10);
    assert.deepStrictEqual(onlySacn.present, ['sacn']);

    const onlyArtnet = dmx.mergeUniverse({ data: a, ts: 5 }, { data: s, ts: 5 }, 'htp', 'artnet');
    assert.strictEqual(onlyArtnet.data[0], 255);
});

test('registry: guarda, purga por timeout y lista universos activos', () => {
    const reg = new dmx.SourceRegistry(1000);
    reg.update('artnet', 1, new Uint8Array(512).fill(5), 1000);
    reg.update('sacn', 1, new Uint8Array(512).fill(9), 1000);
    reg.update('sacn', 2, new Uint8Array(512).fill(9), 1000);

    assert.deepStrictEqual(reg.activeUniverses(), [1, 2]);
    assert.deepStrictEqual(reg.activeFor('artnet'), [1]);
    assert.strictEqual(reg.unified(1, 'htp', 'both').data[0], 9);

    reg.purge(3000); // timeout 1000ms
    assert.deepStrictEqual(reg.activeUniverses(), []);
});

test('normalizeConfig: los presets viejos (planos) siguen funcionando', () => {
    const cfg = dmx.normalizeConfig({
        enabled: true,
        inInterface: '192.168.1.10',
        outInterface: '10.0.0.5',
        targetIp: 'Multicast',
        universeOffset: 1,
        mutedUniverses: [0],
    }, require('../server').DEFAULT_CONFIG);

    assert.strictEqual(cfg.artnetIn.interface, '192.168.1.10');
    assert.strictEqual(cfg.sacnIn.interface, '192.168.1.10');
    assert.strictEqual(cfg.out.interface, '10.0.0.5');
    assert.strictEqual(cfg.out.targetMode, 'multicast');
    assert.strictEqual(cfg.universeOffset, 1);
    assert.deepStrictEqual(cfg.mutedUniverses, [0]);
});
