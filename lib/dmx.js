'use strict';
/**
 * dmx.js — Codec y unificación de DMX sobre Art-Net (ArtDmx) y sACN (E1.31).
 *
 * Módulo puro (sin sockets) para poder testearse de forma aislada.
 *
 * Art-Net "ArtDmx":
 *   0..7    ID "Art-Net\0"
 *   8..9    OpCode 0x5000 (little endian)
 *   10..11  ProtVer hi/lo (0, 14)
 *   12      Sequence
 *   13      Physical
 *   14      SubUni (byte bajo del universo)
 *   15      Net    (byte alto del universo)
 *   16..17  Length (big endian)
 *   18..    DMX (hasta 512 bytes)
 *
 * sACN E1.31 (638 bytes con 512 slots):
 *   4..15   "ASC-E1.17\0\0\0"
 *   22..37  CID
 *   44..107 Source name
 *   108     Priority
 *   111     Sequence
 *   113..114 Universe (big endian)
 *   126..637 DMX
 */

const DMX_SLOTS = 512;
const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const ARTNET_ID = 'Art-Net';
const ACN_ID = 'ASC-E1.17';
const ARTNET_HEADER = 18;
const SACN_HEADER = 126;
const SACN_PACKET_SIZE = 638;

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

/**
 * Unifica dos fuentes de un mismo universo.
 * @param {{data: Uint8Array|Buffer, ts: number}|undefined} artnet
 * @param {{data: Uint8Array|Buffer, ts: number}|undefined} sacn
 * @param {'htp'|'ltp'} policy  htp = el valor más alto gana, ltp = gana la fuente más reciente
 * @param {'both'|'artnet'|'sacn'} sources  qué fuentes se tienen en cuenta
 * @returns {{data: Uint8Array, winner: 'artnet'|'sacn'|'mix'|null, present: string[]}|null}
 */
function mergeUniverse(artnet, sacn, policy = 'htp', sources = 'both') {
    const useArtnet = sources === 'both' || sources === 'artnet';
    const useSacn = sources === 'both' || sources === 'sacn';
    const a = useArtnet ? artnet : undefined;
    const s = useSacn ? sacn : undefined;
    if (!a && !s) return null;

    const present = [];
    if (a) present.push('artnet');
    if (s) present.push('sacn');

    if (a && !s) return { data: toSlots(a.data), winner: 'artnet', present };
    if (s && !a) return { data: toSlots(s.data), winner: 'sacn', present };

    if (policy === 'ltp') {
        const newest = (a.ts || 0) >= (s.ts || 0) ? a : s;
        return {
            data: toSlots(newest.data),
            winner: newest === a ? 'artnet' : 'sacn',
            present,
        };
    }

    // HTP: mezcla canal por canal tomando el mayor valor
    const out = new Uint8Array(DMX_SLOTS);
    const ad = toSlots(a.data);
    const sd = toSlots(s.data);
    let differs = false;
    for (let i = 0; i < DMX_SLOTS; i++) {
        const va = ad[i] || 0;
        const vs = sd[i] || 0;
        out[i] = va >= vs ? va : vs;
        if (va !== vs) differs = true;
    }
    return { data: out, winner: differs ? 'mix' : (a.ts >= s.ts ? 'artnet' : 'sacn'), present };
}

/** Copia cualquiera de los tipos de entrada a un Uint8Array(512) nuevo. */
function toSlots(data) {
    const out = new Uint8Array(DMX_SLOTS);
    if (!data) return out;
    const len = Math.min(data.length, DMX_SLOTS);
    for (let i = 0; i < len; i++) out[i] = data[i];
    return out;
}

/** Buffers por universo con marca de tiempo, con limpieza de los inactivos. */
class SourceRegistry {
    constructor(timeoutMs = 4000) {
        this.timeoutMs = timeoutMs;
        this.artnet = new Map(); // universe -> { data: Uint8Array, ts }
        this.sacn = new Map();
    }

    update(source, universe, data, ts = Date.now()) {
        const map = source === 'artnet' ? this.artnet : this.sacn;
        map.set(universe, { data: toSlots(data), ts });
    }

    purge(now = Date.now()) {
        for (const map of [this.artnet, this.sacn]) {
            for (const [uni, entry] of map.entries()) {
                if (now - entry.ts > this.timeoutMs) map.delete(uni);
            }
        }
    }

    activeUniverses() {
        return Array.from(new Set([...this.artnet.keys(), ...this.sacn.keys()])).sort((a, b) => a - b);
    }

    /** Universos activos de una sola fuente (para la vista por protocolo). */
    activeFor(source) {
        const map = source === 'artnet' ? this.artnet : this.sacn;
        return Array.from(map.keys()).sort((a, b) => a - b);
    }

    isActive(source, universe, windowMs = 2000, now = Date.now()) {
        const map = source === 'artnet' ? this.artnet : this.sacn;
        const entry = map.get(universe);
        return !!entry && now - entry.ts <= windowMs;
    }

    /** Estado unificado de un universo. */
    unified(universe, policy, sources) {
        return mergeUniverse(this.artnet.get(universe), this.sacn.get(universe), policy, sources);
    }

    /** Todos los universos unificados que hoy tienen datos. */
    unifiedAll(policy, sources) {
        const out = new Map();
        for (const uni of this.activeUniverses()) {
            const merged = this.unified(uni, policy, sources);
            if (merged) out.set(uni, merged);
        }
        return out;
    }
}

/** Normaliza configs viejas (planas) a la estructura nueva por secciones. */
function normalizeConfig(raw, defaults) {
    const cfg = { ...defaults, ...(raw || {}) };
    cfg.artnetIn = { ...defaults.artnetIn, ...(raw && raw.artnetIn) };
    cfg.sacnIn = { ...defaults.sacnIn, ...(raw && raw.sacnIn) };
    cfg.merge = { ...defaults.merge, ...(raw && raw.merge) };
    cfg.out = { ...defaults.out, ...(raw && raw.out) };

    // Compatibilidad con presets viejos
    if (raw && raw.inInterface !== undefined && (!raw.artnetIn)) {
        cfg.artnetIn.interface = raw.inInterface || '0.0.0.0';
        cfg.sacnIn.interface = raw.inInterface || '0.0.0.0';
    }
    if (raw && raw.outInterface !== undefined && (!raw.out)) {
        cfg.out.interface = raw.outInterface || '';
    }
    if (raw && raw.targetIp !== undefined && (!raw.out || raw.out.targetIp === undefined)) {
        const t = String(raw.targetIp);
        if (t.toLowerCase() === 'multicast') {
            cfg.out.targetMode = 'multicast';
        } else {
            cfg.out.targetMode = 'unicast';
            cfg.out.targetIp = t;
        }
    }
    return cfg;
}

module.exports = {
    DMX_SLOTS,
    ARTNET_PORT,
    SACN_PORT,
    sacnMulticastIp,
    sacnMulticastGroups,
    artNetUniverseFields,
    buildArtNetDmx,
    parseArtNetDmx,
    buildSacn,
    parseSacn,
    mergeUniverse,
    toSlots,
    SourceRegistry,
    normalizeConfig,
};
