'use strict';
/**
 * Tests unitarios del codec Art-Net/sACN, de la unificación y del modelo de 2 ENTRADAS.
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
    assert.strictEqual(packet.readUInt8(14), 600 & 0xff);
    assert.strictEqual(packet.readUInt8(15), 600 >> 8);
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
    assert.strictEqual(packet.readUInt8(108), 120);

    const parsed = dmx.parseSacn(packet);
    assert.ok(parsed);
    assert.strictEqual(parsed.universe, 3);
    assert.strictEqual(parsed.data[4], 77);
    assert.strictEqual(parsed.sequence, 5);
});

test('sACN: ignora paquetes de sincronización (start code != 0)', () => {
    const packet = dmx.buildSacn(1, new Uint8Array(512));
    packet.writeUInt8(0xcc, 125);
    assert.strictEqual(dmx.parseSacn(packet), null);
});

test('parseFor: parsea según el protocolo de la entrada', () => {
    const a = dmx.buildArtNetDmx(2, new Uint8Array(512));
    const s = dmx.buildSacn(2, new Uint8Array(512));
    assert.strictEqual(dmx.parseFor('artnet', a).universe, 2);
    assert.strictEqual(dmx.parseFor('sacn', s).universe, 2);
    // cruzados: cada parser rechaza el paquete del otro protocolo
    assert.strictEqual(dmx.parseFor('artnet', s), null);
    assert.strictEqual(dmx.parseFor('sacn', a), null);
});

test('multicast sACN: universo -> 239.255.<hi>.<lo>', () => {
    assert.strictEqual(dmx.sacnMulticastIp(1), '239.255.0.1');
    assert.strictEqual(dmx.sacnMulticastIp(300), '239.255.1.44');
    assert.deepStrictEqual(dmx.sacnMulticastGroups(1, 3), ['239.255.0.1', '239.255.0.2', '239.255.0.3']);
});

test('unificación HTP: gana el valor más alto canal por canal', () => {
    const a = new Uint8Array(512); a[0] = 100; a[1] = 10;
    const b = new Uint8Array(512); b[0] = 50;  b[1] = 200;
    const merged = dmx.mergeUniverse({ data: a, ts: 1 }, { data: b, ts: 2 }, 'htp', 'both');

    assert.strictEqual(merged.data[0], 100);
    assert.strictEqual(merged.data[1], 200);
    assert.strictEqual(merged.winner, 'mix');
    assert.deepStrictEqual(merged.present.sort(), ['input1', 'input2']);
});

test('unificación LTP: gana la fuente más reciente (universo completo)', () => {
    const a = new Uint8Array(512); a[0] = 100;
    const b = new Uint8Array(512); b[0] = 50;

    const newerB = dmx.mergeUniverse({ data: a, ts: 10 }, { data: b, ts: 20 }, 'ltp', 'both');
    assert.strictEqual(newerB.data[0], 50);
    assert.strictEqual(newerB.winner, 'input2');

    const newerA = dmx.mergeUniverse({ data: a, ts: 30 }, { data: b, ts: 20 }, 'ltp', 'both');
    assert.strictEqual(newerA.data[0], 100);
    assert.strictEqual(newerA.winner, 'input1');
});

test('unificación: con una sola fuente pasa tal cual', () => {
    const a = new Uint8Array(512); a[7] = 42;
    const only = dmx.mergeUniverse({ data: a, ts: 1 }, undefined, 'htp', 'both');
    assert.strictEqual(only.data[7], 42);
    assert.strictEqual(only.winner, 'input1');
});

test('unificación: el selector de fuentes elige entrada 1, entrada 2 o ambas', () => {
    const a = new Uint8Array(512); a[0] = 255;
    const b = new Uint8Array(512); b[0] = 10;

    const solo1 = dmx.mergeUniverse({ data: a, ts: 5 }, { data: b, ts: 5 }, 'htp', 'input1');
    assert.strictEqual(solo1.data[0], 255);
    assert.deepStrictEqual(solo1.present, ['input1']);

    const solo2 = dmx.mergeUniverse({ data: a, ts: 5 }, { data: b, ts: 5 }, 'htp', 'input2');
    assert.strictEqual(solo2.data[0], 10);
    assert.deepStrictEqual(solo2.present, ['input2']);
});

test('registry: dos entradas independientes, purga por timeout', () => {
    const reg = new dmx.SourceRegistry(1000);
    reg.update(0, 1, new Uint8Array(512).fill(5), 1000);
    reg.update(1, 1, new Uint8Array(512).fill(9), 1000);
    reg.update(1, 2, new Uint8Array(512).fill(9), 1000);

    assert.deepStrictEqual(reg.activeUniverses(), [1, 2]);
    assert.deepStrictEqual(reg.activeFor(0), [1]);
    assert.deepStrictEqual(reg.activeFor(1), [1, 2]);
    assert.strictEqual(reg.unified(1, 'htp', 'both').data[0], 9);

    reg.purge(3000);
    assert.deepStrictEqual(reg.activeUniverses(), []);
});

test('normalizeConfig: estructura nueva con dos entradas genéricas', () => {
    const cfg = dmx.normalizeConfig({
        inputs: [
            { protocol: 'sacn', interface: '192.168.1.50', muted: [3, '4'] },
            { protocol: 'artnet', enabled: false },
        ],
        merge: { sources: 'input1' },
        out: { protocol: 'artnet', targetMode: 'broadcast' },
    }, dmx.DEFAULT_CONFIG);

    assert.strictEqual(cfg.inputs[0].protocol, 'sacn');
    assert.strictEqual(cfg.inputs[0].interface, '192.168.1.50');
    assert.deepStrictEqual(cfg.inputs[0].muted, [3, 4]);
    assert.strictEqual(cfg.inputs[1].protocol, 'artnet');
    assert.strictEqual(cfg.inputs[1].enabled, false);
    assert.strictEqual(cfg.merge.sources, 'input1');
    assert.strictEqual(cfg.out.targetMode, 'broadcast');
});

test('normalizeConfig: compatible con la config v2 (artnetIn/sacnIn) y v1 (plana)', () => {
    const v2 = dmx.normalizeConfig({
        enabled: true,
        artnetIn: { enabled: true, interface: '10.0.0.5' },
        sacnIn: { enabled: false, interface: '10.0.0.6', multicastFrom: 5, multicastTo: 10 },
        out: { protocol: 'sacn' },
        mutedUniverses: [0, 7],
    }, dmx.DEFAULT_CONFIG);

    assert.strictEqual(v2.inputs[0].protocol, 'artnet');
    assert.strictEqual(v2.inputs[0].interface, '10.0.0.5');
    assert.deepStrictEqual(v2.inputs[0].muted, [0, 7]);   // el mute viejo pasa a la entrada 1
    assert.strictEqual(v2.inputs[1].protocol, 'sacn');
    assert.strictEqual(v2.inputs[1].enabled, false);
    assert.strictEqual(v2.inputs[1].multicastTo, 10);

    const v1 = dmx.normalizeConfig({
        enabled: true,
        inInterface: '192.168.1.10',
        outInterface: '10.0.0.5',
        targetIp: 'Multicast',
        universeOffset: 1,
        mutedUniverses: [2],
    }, dmx.DEFAULT_CONFIG);

    assert.strictEqual(v1.inputs[0].interface, '192.168.1.10');
    assert.strictEqual(v1.inputs[1].interface, '192.168.1.10');
    assert.strictEqual(v1.out.interface, '10.0.0.5');
    assert.strictEqual(v1.out.targetMode, 'multicast');
    assert.strictEqual(v1.universeOffset, 1);
    assert.deepStrictEqual(v1.inputs[0].muted, [2]);
});

test('silenciado por entrada: isMutedInInput y toggleMuted', () => {
    const cfg = dmx.normalizeConfig({ inputs: [{ protocol: 'artnet' }, { protocol: 'sacn' }] }, dmx.DEFAULT_CONFIG);

    assert.strictEqual(dmx.isMutedInInput(0, cfg, 5), false);

    assert.strictEqual(dmx.toggleMuted(cfg, 0, 5), true);    // silencia
    assert.strictEqual(dmx.isMutedInInput(0, cfg, 5), true);
    assert.strictEqual(dmx.isMutedInInput(1, cfg, 5), false); // en la otra entrada no afecta

    assert.strictEqual(dmx.toggleMuted(cfg, 0, 5), false);   // dessilencia
    assert.strictEqual(dmx.isMutedInInput(0, cfg, 5), false);

    dmx.toggleMuted(cfg, 1, 9);
    dmx.toggleMuted(cfg, 1, 4);
    assert.deepStrictEqual(cfg.inputs[1].muted, [4, 9]);     // se mantiene ordenado
});
