'use strict';
/**
 * dmx.js — Codec y unificación de DMX sobre Art-Net (ArtDmx) y sACN (E1.31).
 *
 * Módulo puro (sin sockets) para poder testearse de forma aislada.
 *
 * Art-Net "ArtDmx":  ID "Art-Net\0" | opcode 0x5000 (LE) | ProtVer | Seq | Physical |
 *                    SubUni | Net | Length (BE) | DMX  (cabecera 18 bytes)
 * sACN E1.31:        "ASC-E1.17\0\0\0" | CID | source name | priority | seq | universe (BE) |
 *                    DMP | start code | DMX  (638 bytes con 512 slots)
 *
 * Modelo de ENTRADAS (v2.1): dos entradas GENÉRICAS. Cada una elige su protocolo
 * ('artnet' | 'sacn'), su placa de red y sus universos silenciados.
 */

const DMX_SLOTS = 512;
const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const ARTNET_ID = 'Art-Net';
const ACN_ID = 'ASC-E1.17';
const ARTNET_HEADER = 18;
const SACN_HEADER = 126;
const SACN_PACKET_SIZE = 638;

const PROTOCOLS = ['artnet', 'sacn'];

/** Universo (15 bits) -> campos SubUni/Net de Art-Net. */
function artNetUniverseFields(universe) {
    return { subUni: universe & 0xff, net: (universe >> 8) & 0x7f };
}

/** Universo -> IP multicast sACN (239.255.<hi>.<lo>). */
function sacnMulticastIp(universe) {
    return `239.255.${Math.floor(universe / 256)}.${universe % 256}`;
}

/** Lista de grupos multicast para un rango de universos (inclusive). */
function sacnMulticastGroups(from, to) {
    const groups = [];
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(63999, Math.max(from, to));
    for (let u = start; u <= end; u++) groups.push(sacnMulticastIp(u));
    return groups;
}

/** Arma un paquete Art-Net ArtDmx completo. */
function buildArtNetDmx(universe, data, sequence = 0, physical = 0) {
    const len = Math.min(data ? data.length : DMX_SLOTS, DMX_SLOTS);
    const buf = Buffer.alloc(ARTNET_HEADER + Math.max(len, 2), 0);
    buf.write(ARTNET_ID, 0, 8, 'ascii');
    buf.writeUInt8(0, 7); // terminador NUL
    buf.writeUInt16LE(0x5000, 8);
    buf.writeUInt8(0, 10); // ProtVerHi
    buf.writeUInt8(14, 11); // ProtVerLo
    buf.writeUInt8(sequence & 0xff, 12);
    buf.writeUInt8(physical & 0xff, 13);
    const { subUni, net } = artNetUniverseFields(universe);
    buf.writeUInt8(subUni, 14);
    buf.writeUInt8(net, 15);
    buf.writeUInt16BE(len, 16);
    if (data && len > 0) Buffer.from(data.buffer || data, data.byteOffset || 0, len).copy(buf, ARTNET_HEADER);
    return buf;
}

/** Parsea un paquete Art-Net; devuelve { universe, data } o null si no es ArtDmx válido. */
function parseArtNetDmx(msg) {
    if (!msg || msg.length < ARTNET_HEADER) return null;
    if (msg.toString('ascii', 0, 7) !== ARTNET_ID) return null;
    if (msg.readUInt16LE(8) !== 0x5000) return null;
    const universe = msg.readUInt16LE(14);
    const length = msg.readUInt16BE(16);
    const data = msg.slice(ARTNET_HEADER, ARTNET_HEADER + Math.min(length, DMX_SLOTS));
    return { universe, data };
}

/** Arma un paquete sACN completo (638 bytes). */
function buildSacn(universe, data, { cid, sequence = 0, priority = 100, sourceName = 'Web DMX/sACN Bridge' } = {}) {
    const buf = Buffer.alloc(SACN_PACKET_SIZE, 0);
    buf.writeUInt16BE(0x0010, 0); // preamble
    buf.writeUInt16BE(0x0000, 2); // postamble
    buf.write(ACN_ID, 4, 9, 'ascii');
    buf.writeUInt8(0, 13);
    buf.writeUInt8(0, 14);
    buf.writeUInt8(0, 15);
    buf.writeUInt16BE(0x726e, 16); // flags+length root
    buf.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
    (cid || Buffer.alloc(16)).copy(buf, 22);
    buf.writeUInt16BE(0x7258, 38); // flags+length framing
    buf.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
    buf.write(String(sourceName).slice(0, 63), 44, 'utf8');
    buf.writeUInt8(priority & 0xff, 108);
    buf.writeUInt16BE(0x0000, 109);
    buf.writeUInt8(sequence & 0xff, 111);
    buf.writeUInt8(0, 112);
    buf.writeUInt16BE(universe & 0xffff, 113);
    buf.writeUInt16BE(0x720b, 115); // flags+length DMP
    buf.writeUInt8(0x02, 117);
    buf.writeUInt8(0xa1, 118);
    buf.writeUInt16BE(0x0000, 119);
    buf.writeUInt16BE(0x0001, 121);
    buf.writeUInt16BE(0x0201, 123);
    buf.writeUInt8(0x00, 125); // start code
    if (data) {
        const len = Math.min(data.length, DMX_SLOTS);
        Buffer.from(data.buffer || data, data.byteOffset || 0, len).copy(buf, SACN_HEADER);
    }
    return buf;
}

/** Parsea un paquete sACN; devuelve { universe, data, priority, sequence, cid } o null. */
function parseSacn(msg) {
    if (!msg || msg.length < SACN_HEADER) return null;
    // El identificador ACN son 12 bytes en 4..16: "ASC-E1.17" + 3 NUL
    if (!msg.toString('ascii', 4, 16).startsWith(ACN_ID)) return null;
    // start code: sólo interesa el 0x00 (DMX). Otros (0xcc sync) se ignoran.
    if (msg.readUInt8(125) !== 0x00) return null;
    const universe = msg.readUInt16BE(113);
    const data = msg.slice(SACN_HEADER, Math.min(msg.length, SACN_HEADER + DMX_SLOTS));
    return {
        universe,
        data,
        priority: msg.readUInt8(108),
        sequence: msg.readUInt8(111),
        cid: msg.slice(22, 38),
    };
}

/** Parsea según el protocolo de la entrada. */
function parseFor(protocol, msg) {
    return protocol === 'sacn' ? parseSacn(msg) : parseArtNetDmx(msg);
}

/**
 * Unifica las fuentes de un mismo universo.
 * @param {{data: Uint8Array|Buffer, ts: number}|undefined} a  fuente 1
 * @param {{data: Uint8Array|Buffer, ts: number}|undefined} b  fuente 2
 * @param {'htp'|'ltp'} policy  htp = el valor más alto gana, ltp = gana la fuente más reciente
 * @param {'both'|'input1'|'input2'} sources  qué fuentes se tienen en cuenta
 * @returns {{data: Uint8Array, winner: 'input1'|'input2'|'mix'|null, present: string[]}|null}
 */
function mergeUniverse(a, b, policy = 'htp', sources = 'both') {
    const useA = sources === 'both' || sources === 'input1';
    const useB = sources === 'both' || sources === 'input2';
    const f1 = useA ? a : undefined;
    const f2 = useB ? b : undefined;
    if (!f1 && !f2) return null;

    const present = [];
    if (f1) present.push('input1');
    if (f2) present.push('input2');

    if (f1 && !f2) return { data: toSlots(f1.data), winner: 'input1', present };
    if (f2 && !f1) return { data: toSlots(f2.data), winner: 'input2', present };

    if (policy === 'ltp') {
        const newest = (f1.ts || 0) >= (f2.ts || 0) ? f1 : f2;
        return { data: toSlots(newest.data), winner: newest === f1 ? 'input1' : 'input2', present };
    }

    // HTP: mezcla canal por canal tomando el mayor valor
    const out = new Uint8Array(DMX_SLOTS);
    const d1 = toSlots(f1.data);
    const d2 = toSlots(f2.data);
    let differs = false;
    for (let i = 0; i < DMX_SLOTS; i++) {
        const v1 = d1[i] || 0;
        const v2 = d2[i] || 0;
        out[i] = v1 >= v2 ? v1 : v2;
        if (v1 !== v2) differs = true;
    }
    return { data: out, winner: differs ? 'mix' : (f1.ts >= f2.ts ? 'input1' : 'input2'), present };
}

/** Copia cualquiera de los tipos de entrada a un Uint8Array(512) nuevo. */
function toSlots(data) {
    const out = new Uint8Array(DMX_SLOTS);
    if (!data) return out;
    const len = Math.min(data.length, DMX_SLOTS);
    for (let i = 0; i < len; i++) out[i] = data[i];
    return out;
}

/**
 * Registro de las dos entradas: guarda el último buffer por universo de cada una
 * con marca de tiempo, y calcula el estado unificado.
 */
class SourceRegistry {
    constructor(timeoutMs = 4000) {
        this.timeoutMs = timeoutMs;
        this.sources = [new Map(), new Map()]; // índice 0 = entrada 1, 1 = entrada 2
    }

    /** index: 0 | 1 */
    update(index, universe, data, ts = Date.now()) {
        this.sources[index].set(universe, { data: toSlots(data), ts });
    }

    purge(now = Date.now()) {
        for (const map of this.sources) {
            for (const [uni, entry] of map.entries()) {
                if (now - entry.ts > this.timeoutMs) map.delete(uni);
            }
        }
    }

    activeFor(index) {
        return Array.from(this.sources[index].keys()).sort((a, b) => a - b);
    }

    activeUniverses() {
        return Array.from(new Set([...this.sources[0].keys(), ...this.sources[1].keys()])).sort((a, b) => a - b);
    }

    isActive(index, universe, windowMs = 2000, now = Date.now()) {
        const entry = this.sources[index].get(universe);
        return !!entry && now - entry.ts <= windowMs;
    }

    unified(universe, policy, sources) {
        return mergeUniverse(this.sources[0].get(universe), this.sources[1].get(universe), policy, sources);
    }

    unifiedAll(policy, sources) {
        const out = new Map();
        for (const uni of this.activeUniverses()) {
            const merged = this.unified(uni, policy, sources);
            if (merged) out.set(uni, merged);
        }
        return out;
    }
}

const DEFAULT_INPUT = {
    protocol: 'artnet',
    enabled: true,
    interface: '0.0.0.0',   // '0.0.0.0' = todas las placas, o una IP concreta (incluye 127.0.0.1)
    muted: [],              // universos silenciados EN ESTA ENTRADA
    multicastFrom: 1,
    multicastTo: 100,
    joinMulticast: true,
};

const DEFAULT_CONFIG = {
    enabled: false,
    inputs: [
        Object.assign({}, DEFAULT_INPUT, { protocol: 'artnet' }),
        Object.assign({}, DEFAULT_INPUT, { protocol: 'sacn' }),
    ],
    merge: {
        sources: 'both',   // 'both' | 'input1' | 'input2'  (la mezcla interna es HTP)
    },
    out: {
        protocol: 'sacn',       // 'sacn' | 'artnet'
        interface: '',          // '' = ruta por defecto
        targetMode: 'multicast', // 'multicast' | 'unicast' | 'broadcast'
        targetIp: '127.0.0.1',
        port: null,             // null = 5568 para sACN / 6454 para Art-Net
        rate: 30,               // Hz del bucle de salida
    },
    universeOffset: 0,
};

/** Normaliza cualquier config (nueva o vieja) a la estructura v2.1. */
function normalizeConfig(raw, defaults = DEFAULT_CONFIG) {
    const cfg = Object.assign({}, defaults, raw || {});

    // --- entradas ---
    let entradas = Array.isArray(cfg.inputs) ? cfg.inputs.slice(0, 2) : [];
    // Comodidad: permitir inputs como objeto { input1: {...}, input2: {...} }
    if (!Array.isArray(cfg.inputs) && cfg.inputs && typeof cfg.inputs === 'object') {
        entradas = [cfg.inputs.input1, cfg.inputs.input2].filter(Boolean);
    }
    while (entradas.length < 2) entradas.push({});
    cfg.inputs = entradas.map((entrada, i) => {
        const base = Object.assign({}, DEFAULT_INPUT, defaults.inputs[i] || {}, entrada || {});
        if (!PROTOCOLS.includes(base.protocol)) base.protocol = defaults.inputs[i].protocol;
        base.enabled = base.enabled !== false;
        base.muted = Array.isArray(base.muted)
            ? base.muted.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n))
            : [];
        base.multicastFrom = parseInt(base.multicastFrom, 10) || 0;
        base.multicastTo = parseInt(base.multicastTo, 10) || 0;
        return base;
    });

    // --- compatibilidad con la config vieja (artnetIn / sacnIn planos) ---
    if (raw && !raw.inputs && (raw.artnetIn || raw.sacnIn)) {
        const a = raw.artnetIn || {};
        const s = raw.sacnIn || {};
        cfg.inputs[0] = Object.assign({}, DEFAULT_INPUT, a, { protocol: 'artnet' });
        cfg.inputs[1] = Object.assign({}, DEFAULT_INPUT, s, { protocol: 'sacn' });
        if (Array.isArray(raw.mutedUniverses)) cfg.inputs[0].muted = raw.mutedUniverses.slice();
    }
    // config v1 (planísima): inInterface / outInterface / targetIp / mutedUniverses
    if (raw && raw.inInterface !== undefined && !raw.inputs && !raw.artnetIn && !raw.sacnIn) {
        cfg.inputs[0].interface = raw.inInterface || '0.0.0.0';
        cfg.inputs[1].interface = raw.inInterface || '0.0.0.0';
        if (Array.isArray(raw.mutedUniverses)) cfg.inputs[0].muted = raw.mutedUniverses.slice();
    }

    // --- unificación ---
    cfg.merge = Object.assign({}, defaults.merge, raw && raw.merge);
    if (cfg.merge.sources === 'artnet') cfg.merge.sources = 'input1';
    if (cfg.merge.sources === 'sacn') cfg.merge.sources = 'input2';
    if (!['both', 'input1', 'input2'].includes(cfg.merge.sources)) cfg.merge.sources = 'both';

    // --- salida ---
    cfg.out = Object.assign({}, defaults.out, raw && raw.out);
    if (raw && raw.outInterface !== undefined && !(raw.out && raw.out.interface !== undefined)) {
        cfg.out.interface = raw.outInterface || '';
    }
    if (raw && raw.targetIp !== undefined && !(raw.out && raw.out.targetMode)) {
        const t = String(raw.targetIp);
        if (t.toLowerCase() === 'multicast') {
            cfg.out.targetMode = 'multicast';
        } else {
            cfg.out.targetMode = 'unicast';
            cfg.out.targetIp = t;
        }
    }

    cfg.universeOffset = parseInt(cfg.universeOffset, 10) || 0;
    cfg.enabled = cfg.enabled === true;
    delete cfg.mutedUniverses; // v2.1: el silenciado vive en cada entrada
    return cfg;
}

/** ¿Este universo está silenciado en esta entrada? */
function isMutedInInput(inputIndex, cfg, universe) {
    const entrada = cfg.inputs && cfg.inputs[inputIndex];
    return !!(entrada && Array.isArray(entrada.muted) && entrada.muted.includes(universe));
}

/** Alterna el silenciado de un universo en una entrada (devuelve el nuevo estado). */
function toggleMuted(cfg, inputIndex, universe) {
    const entrada = cfg.inputs[inputIndex];
    if (!entrada) return false;
    const i = entrada.muted.indexOf(universe);
    if (i >= 0) {
        entrada.muted.splice(i, 1);
        return false;
    }
    entrada.muted.push(universe);
    entrada.muted.sort((a, b) => a - b);
    return true;
}

module.exports = {
    DMX_SLOTS,
    ARTNET_PORT,
    SACN_PORT,
    PROTOCOLS,
    sacnMulticastIp,
    sacnMulticastGroups,
    artNetUniverseFields,
    buildArtNetDmx,
    parseArtNetDmx,
    buildSacn,
    parseSacn,
    parseFor,
    mergeUniverse,
    toSlots,
    SourceRegistry,
    DEFAULT_CONFIG,
    DEFAULT_INPUT,
    normalizeConfig,
    isMutedInInput,
    toggleMuted,
};
