'use strict';
/**
 * DMX / sACN Web Visualizer & Network Bridge
 *
 * Entradas (cada una con su propia placa de red, ambas pueden escuchar a la vez):
 *   - Art-Net DMX  (UDP 6454)
 *   - sACN E1.31   (UDP 5568, unicast + multicast 239.255.x.y)
 * Unificación: HTP (el valor más alto) o LTP (la fuente más reciente).
 * Salida: sACN o Art-Net DMX, hacia multicast / unicast / broadcast, con placa elegible.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dmx = require('./lib/dmx');

const PRESETS_DIR = path.join(__dirname, 'presets');

const DEFAULT_CONFIG = {
    enabled: false,
    // --- Entrada Art-Net ---
    artnetIn: {
        enabled: true,
        interface: '0.0.0.0', // '0.0.0.0' = todas las placas, o una IP concreta (incluye 127.0.0.1)
    },
    // --- Entrada sACN ---
    sacnIn: {
        enabled: true,
        interface: '0.0.0.0',
        multicastFrom: 1,
        multicastTo: 100,
        joinMulticast: true,
    },
    // --- Unificación ---
    merge: {
        policy: 'htp',        // 'htp' | 'ltp'
        sources: 'both',      // 'both' | 'artnet' | 'sacn'
    },
    // --- Salida ---
    out: {
        protocol: 'sacn',     // 'sacn' | 'artnet'
        interface: '',        // '' = ruta por defecto
        targetMode: 'multicast', // 'multicast' | 'unicast' | 'broadcast'
        targetIp: '127.0.0.1',
        port: null,           // null = 5568 para sACN / 6454 para Art-Net
        rate: 30,             // Hz del bucle de salida
    },
    universeOffset: 0,
    mutedUniverses: [],
};

function isIPv4(addr) {
    return typeof addr === 'string' && addr.split('.').length === 4 && !addr.includes(':');
}

function createApp(opts = {}) {
    const httpPort = opts.port || process.env.PORT || 3000;
    const artnetInPort = opts.artnetInPort || dmx.ARTNET_PORT;
    const sacnInPort = opts.sacnInPort || dmx.SACN_PORT;
    const verbose = opts.verbose !== false;

    if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });

    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));
    const server = http.createServer(app);
    const io = new Server(server);

    const registry = new dmx.SourceRegistry(4000);
    const bridgeCid = crypto.randomBytes(16);
    const sequences = new Map(); // "proto:universe" -> seq

    let config = dmx.normalizeConfig({}, DEFAULT_CONFIG);
    const stats = {
        received: { artnet: 0, sacn: 0 },
        sent: { artnet: 0, sacn: 0 },
        lastSendError: null,
        lastSendAt: null,
        boundTo: { artnet: null, sacn: null, out: null },
        multicastGroups: 0,
    };

    // ---------------------------------------------------------------- recepción
    let artnetSocket = null;
    let sacnSocket = null;

    function log(...args) {
        if (verbose) console.log(...args);
    }

    function listenInterface(iface) {
        // '0.0.0.0' / '' => todas las placas (bind sin dirección)
        return !iface || iface === '0.0.0.0' ? undefined : iface;
    }

    function closeArtnet() {
        if (artnetSocket) {
            try { artnetSocket.close(); } catch (e) { /* ignorado */ }
            artnetSocket = null;
        }
    }

    function closeSacn() {
        if (sacnSocket) {
            try { sacnSocket.dropMembership?.(); } catch (e) { /* ignorado */ }
            try { sacnSocket.close(); } catch (e) { /* ignorado */ }
            sacnSocket = null;
        }
    }

    function bindArtnet() {
        closeArtnet();
        if (!config.artnetIn.enabled) {
            stats.boundTo.artnet = null;
            return;
        }
        const addr = listenInterface(config.artnetIn.interface);
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sock.on('error', (err) => log(`[Art-Net IN] error: ${err.message}`));
        sock.on('message', (msg) => {
            const parsed = dmx.parseArtNetDmx(msg);
            if (!parsed) return;
            stats.received.artnet++;
            registry.update('artnet', parsed.universe, parsed.data);
            io.to(`artnet-${parsed.universe}`).to('artnet-all').emit('dmx-data', {
                protocol: 'ArtNet',
                universe: parsed.universe,
                data: Array.from(parsed.data),
            });
        });
        sock.bind(artnetInPort, addr, () => {
            stats.boundTo.artnet = addr || '0.0.0.0';
            log(`[Art-Net IN] escuchando en ${stats.boundTo.artnet}:${artnetInPort}`);
        });
        artnetSocket = sock;
    }

    function bindSacn() {
        closeSacn();
        if (!config.sacnIn.enabled) {
            stats.boundTo.sacn = null;
            return;
        }
        const addr = listenInterface(config.sacnIn.interface);
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sock.on('error', (err) => log(`[sACN IN] error: ${err.message}`));
        sock.on('message', (msg) => {
            const parsed = dmx.parseSacn(msg);
            if (!parsed) return;
            stats.received.sacn++;
            registry.update('sacn', parsed.universe, parsed.data);
            io.to(`sacn-${parsed.universe}`).to('sacn-all').emit('dmx-data', {
                protocol: 'sACN',
                universe: parsed.universe,
                data: Array.from(parsed.data),
            });
        });
        sock.bind(sacnInPort, addr, () => {
            stats.boundTo.sacn = addr || '0.0.0.0';
            log(`[sACN IN] escuchando en ${stats.boundTo.sacn}:${sacnInPort}`);

            // Unirse a los grupos multicast: permite recibir sACN multicast además del unicast
            if (config.sacnIn.joinMulticast) {
                const iface = addr; // undefined = default; si es una IP concreta, se une por esa placa
                let joined = 0;
                const from = Math.min(config.sacnIn.multicastFrom, config.sacnIn.multicastTo);
                const to = Math.min(Math.max(config.sacnIn.multicastFrom, config.sacnIn.multicastTo), from + 512);
                for (let u = from; u <= to; u++) {
                    try {
                        sock.addMembership(dmx.sacnMulticastIp(u), iface);
                        joined++;
                    } catch (e) {
                        // Grupo ya unido o placa sin soporte multicast: se ignora
                    }
                }
                stats.multicastGroups = joined;
                log(`[sACN IN] unido a ${joined} grupos multicast (universos ${from}-${to})`);
            }
        });
        sacnSocket = sock;
    }

    // ------------------------------------------------------------------- salida
    let outSocket = dgram.createSocket('udp4');

    function rebindOut() {
        try { outSocket.close(); } catch (e) { /* ignorado */ }
        outSocket = dgram.createSocket('udp4');
        outSocket.on('error', (err) => { stats.lastSendError = err.message; });
        const iface = listenInterface(config.out.interface);
        try {
            outSocket.bind(0, iface, () => {
                stats.boundTo.out = iface || 'default';
                log(`[OUT] socket de salida en ${stats.boundTo.out}`);
            });
        } catch (e) {
            stats.boundTo.out = 'default';
        }
        try {
            outSocket.setBroadcast(true);
        } catch (e) { /* ignorado */ }
    }
    rebindOut();

    function targetFor(universe) {
        const out = config.out;
        if (out.targetMode === 'broadcast') return '255.255.255.255';
        if (out.targetMode === 'unicast') return out.targetIp || '127.0.0.1';
        // multicast (sólo tiene sentido en sACN)
        return out.protocol === 'sacn' ? dmx.sacnMulticastIp(universe) : (out.targetIp || '255.255.255.255');
    }

    function outPort() {
        if (config.out.port) return config.out.port;
        return config.out.protocol === 'artnet' ? dmx.ARTNET_PORT : dmx.SACN_PORT;
    }

    function sendUniverse(universe, slots) {
        const visualizerUni = universe + (config.universeOffset || 0);
        if (config.mutedUniverses && config.mutedUniverses.includes(visualizerUni)) return;

        const destIp = targetFor(visualizerUni);
        const port = outPort();
        const key = `${config.out.protocol}:${universe}`;
        let seq = (sequences.get(key) || 0) + 1;
        if (seq > 255) seq = 0;
        sequences.set(key, seq);

        let packet;
        if (config.out.protocol === 'artnet') {
            packet = dmx.buildArtNetDmx(visualizerUni, slots, seq);
        } else {
            packet = dmx.buildSacn(visualizerUni, slots, { cid: bridgeCid, sequence: seq, priority: 100 });
        }

        if (config.out.targetMode === 'multicast' && config.out.protocol === 'sacn') {
            try {
                outSocket.setMulticastInterface(listenInterface(config.out.interface) || '0.0.0.0');
                outSocket.setMulticastTTL(32);
            } catch (e) { /* ignorado */ }
        }

        outSocket.send(packet, 0, packet.length, port, destIp, (err) => {
            if (err) {
                stats.lastSendError = err.message;
            } else {
                stats.sent[config.out.protocol]++;
                stats.lastSendAt = Date.now();
            }
        });
    }

    // Bucle de salida: manda el estado UNIFICADO de cada universo activo
    let bridgeTimer = null;
    function bridgeTick() {
        if (!config.enabled) return;
        registry.purge();
        const merged = registry.unifiedAll(config.merge.policy, config.merge.sources);
        for (const [universe, entry] of merged.entries()) {
            sendUniverse(universe, entry.data);
        }
    }

    function startBridgeLoop() {
        if (bridgeTimer) clearInterval(bridgeTimer);
        const hz = Math.max(1, Math.min(120, config.out.rate || 30));
        bridgeTimer = setInterval(bridgeTick, Math.round(1000 / hz));
    }
    startBridgeLoop();

    // ------------------------------------------------------------- estado -> UI
    const stateTimer = setInterval(() => {
        registry.purge();
        const merged = registry.unifiedAll(config.merge.policy, config.merge.sources);

        io.emit('active-universes', {
            sACN: registry.activeFor('sacn'),
            ArtNet: registry.activeFor('artnet'),
            Unified: Array.from(merged.keys()),
        });

        // Detalle por universo: qué fuente está presente y quién gana
        const detail = {};
        for (const [uni, entry] of merged.entries()) {
            detail[uni] = { winner: entry.winner, present: entry.present };
        }
        io.emit('unified-info', detail);

        // Datos unificados (para la vista "Unified" del visor)
        for (const [uni, entry] of merged.entries()) {
            io.to(`unified-${uni}`).to('unified-all').emit('dmx-data', {
                protocol: 'Unified',
                universe: uni,
                data: Array.from(entry.data),
            });
        }
    }, 500);

    const statsTimer = setInterval(() => io.emit('bridge-stats', stats), 2000);

    // ---------------------------------------------------------------- socket.io
    io.on('connection', (socket) => {
        log(`Cliente conectado: ${socket.id}`);
        socket.emit('active-universes', {
            sACN: registry.activeFor('sacn'),
            ArtNet: registry.activeFor('artnet'),
            Unified: Array.from(registry.unifiedAll(config.merge.policy, config.merge.sources).keys()),
        });
        socket.emit('bridge-config', config);
        socket.emit('bridge-stats', stats);

        socket.on('join-universe', (payload) => {
            let protocol = 'sACN';
            let universeId = payload;
            if (typeof payload === 'object' && payload !== null) {
                protocol = payload.protocol;
                universeId = payload.universeId;
            }
            socket.rooms.forEach((room) => {
                if (/^(sacn|artnet|unified)-/.test(room)) socket.leave(room);
            });
            const prefix = protocol === 'ArtNet' ? 'artnet' : (protocol === 'Unified' ? 'unified' : 'sacn');
            socket.join(`${prefix}-all`);
            if (universeId !== 'all') socket.join(`${prefix}-${universeId}`);
        });

        socket.on('get-network-interfaces', () => socket.emit('network-interfaces', listInterfaces()));
        socket.on('get-presets', () => socket.emit('presets-list', listPresets()));
        socket.on('update-bridge-config', (partial) => {
            applyConfig(partial);
            io.emit('bridge-config', config);
        });
        socket.on('save-preset', ({ name, config: presetConfig }) => {
            if (!name || !presetConfig) return;
            const safe = name.replace(/[^a-z0-9_-]/gi, '_');
            fs.writeFile(path.join(PRESETS_DIR, `${safe}.json`), JSON.stringify(presetConfig, null, 2), (err) => {
                if (!err) io.emit('presets-list', listPresets());
            });
        });
        socket.on('load-preset', (name) => {
            const safe = String(name).replace(/[^a-z0-9_-]/gi, '_');
            const file = path.join(PRESETS_DIR, `${safe}.json`);
            fs.readFile(file, 'utf8', (err, raw) => {
                if (err) return;
                try {
                    applyConfig(JSON.parse(raw));
                    io.emit('bridge-config', config);
                } catch (e) {
                    console.error('Preset inválido:', e.message);
                }
            });
            // listback para el botón "Load"
            socket.emit('presets-list', listPresets());
        });
    });

    // -------------------------------------------------------------------- API
    app.get('/api/config', (req, res) => res.json({ config, stats, interfaces: listInterfaces() }));
    app.post('/api/config', (req, res) => {
        applyConfig(req.body || {});
        io.emit('bridge-config', config);
        res.json({ ok: true, config });
    });
    app.get('/api/stats', (req, res) => res.json({ stats, boundTo: stats.boundTo }));
    app.post('/api/reset-stats', (req, res) => {
        stats.received.artnet = 0;
        stats.received.sacn = 0;
        stats.sent.artnet = 0;
        stats.sent.sacn = 0;
        res.json({ ok: true });
    });

    // ------------------------------------------------------------- config apply
    function applyConfig(partial) {
        const before = {
            artnetIface: config.artnetIn.interface,
            artnetEnabled: config.artnetIn.enabled,
            sacnIface: config.sacnIn.interface,
            sacnEnabled: config.sacnIn.enabled,
            sacnFrom: config.sacnIn.multicastFrom,
            sacnTo: config.sacnIn.multicastTo,
            outIface: config.out.interface,
        };

        config = dmx.normalizeConfig({ ...config, ...partial }, DEFAULT_CONFIG);

        if (config.artnetIn.interface !== before.artnetIface || config.artnetIn.enabled !== before.artnetEnabled) {
            bindArtnet();
        }
        const sacnChanged = config.sacnIn.interface !== before.sacnIface
            || config.sacnIn.enabled !== before.sacnEnabled
            || config.sacnIn.multicastFrom !== before.sacnFrom
            || config.sacnIn.multicastTo !== before.sacnTo;
        if (sacnChanged) bindSacn();
        if (config.out.interface !== before.outIface) rebindOut();
        if (config.enabled) startBridgeLoop();
    }

    function listInterfaces() {
        const nets = os.networkInterfaces();
        const list = [];
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' || net.family === 4) {
                    if (net.internal && net.address !== '127.0.0.1') continue;
                    list.push({ name, address: net.address, internal: !!net.internal });
                }
            }
        }
        if (!list.some((n) => n.address === '127.0.0.1')) {
            list.push({ name: 'Loopback', address: '127.0.0.1', internal: true });
        }
        return list;
    }

    function listPresets() {
        try {
            return fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
        } catch (e) {
            return [];
        }
    }

    // ------------------------------------------------------------------ arranque
    function start() {
        bindArtnet();
        bindSacn();
        return new Promise((resolve) => {
            server.listen(httpPort, '0.0.0.0', () => {
                log(`[+] Visualizer en http://localhost:${httpPort}`);
                log(`[+] Art-Net IN en UDP ${artnetInPort} · sACN IN en UDP ${sacnInPort}`);
                resolve({ httpPort, artnetInPort, sacnInPort });
            });
        });
    }

    function stop() {
        if (bridgeTimer) clearInterval(bridgeTimer);
        clearInterval(stateTimer);
        clearInterval(statsTimer);
        closeArtnet();
        closeSacn();
        try { outSocket.close(); } catch (e) { /* ignorado */ }
        return new Promise((resolve) => {
            io.close(() => server.close(() => resolve()));
        });
    }

    return {
        app,
        server,
        io,
        registry,
        stats,
        start,
        stop,
        getConfig: () => config,
        applyConfig,
        dmx,
        DEFAULT_CONFIG,
        ports: { httpPort, artnetInPort, sacnInPort },
    };
}

if (require.main === module) {
    const inst = createApp();
    inst.start().then(() => {
        console.log('[+] Puertos: Art-Net 6454 · sACN 5568 · HTTP/Panel ' + inst.ports.httpPort);
    });
}

module.exports = { createApp, DEFAULT_CONFIG, isIPv4 };
