'use strict';
/**
 * DMX / sACN Web Visualizer & Network Bridge — v2.1
 *
 * DOS ENTRADAS GENÉRICAS: cada una elige su protocolo (Art-Net o sACN), su placa de
 * red y sus universos silenciados. Las dos pueden escuchar a la vez y compartir placa.
 * Unificación: qué fuente se unifica (entrada 1, entrada 2 o ambas). La mezcla interna
 * es HTP (el valor más alto por canal), que sólo actúa si las dos traen el mismo universo.
 * SALIDA: sACN o Art-Net DMX hacia multicast / unicast / broadcast, con placa, puerto y
 * frecuencia configurables.
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
const INPUT_LABEL = ['Entrada 1', 'Entrada 2'];

function createApp(opts = {}) {
    const httpPort = opts.port || process.env.PORT || 3000;
    const artnetPort = opts.artnetInPort || dmx.ARTNET_PORT;
    const sacnPort = opts.sacnInPort || dmx.SACN_PORT;
    const verbose = opts.verbose !== false;

    if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });

    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));
    const server = http.createServer(app);
    const io = new Server(server);

    const registry = new dmx.SourceRegistry(4000);
    const bridgeCid = crypto.randomBytes(16);
    const sequences = new Map();

    let config = dmx.normalizeConfig({}, dmx.DEFAULT_CONFIG);

    const stats = {
        received: [{ paquetes: 0, universos: 0 }, { paquetes: 0, universos: 0 }],
        sent: { artnet: 0, sacn: 0 },
        lastSendError: null,
        lastSendAt: null,
        boundTo: [null, null],
        multicastGroups: [0, 0],
        droppedMuted: [0, 0],
    };

    let inputSockets = [null, null];
    let outSocket = dgram.createSocket('udp4');

    function log(...args) {
        if (verbose) console.log(...args);
    }

    const ifaceAddr = (iface) => (!iface || iface === '0.0.0.0' ? undefined : iface);
    const portFor = (protocol) => (protocol === 'sacn' ? sacnPort : artnetPort);

    // ---------------------------------------------------------------- recepción
    function closeInput(i) {
        const sock = inputSockets[i];
        if (!sock) return;
        try { sock.dropMembership && sock.dropMembership(); } catch (e) { /* ignorado */ }
        try { sock.close(); } catch (e) { /* ignorado */ }
        inputSockets[i] = null;
    }

    function bindInput(i) {
        closeInput(i);
        const entrada = config.inputs[i];
        stats.boundTo[i] = null;
        stats.multicastGroups[i] = 0;
        if (!entrada.enabled) return;

        const addr = ifaceAddr(entrada.interface);
        const port = portFor(entrada.protocol);
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        sock.on('error', (err) => log(`[${INPUT_LABEL[i]}] error: ${err.message}`));
        sock.on('message', (msg) => {
            const parsed = dmx.parseFor(entrada.protocol, msg);
            if (!parsed) return;

            // Silenciado POR ENTRADA: si el universo está silenciado acá, no entra al sistema
            if (dmx.isMutedInInput(i, config, parsed.universe)) {
                stats.droppedMuted[i]++;
                return;
            }

            stats.received[i].paquetes++;
            registry.update(i, parsed.universe, parsed.data);

            io.to(`in${i + 1}-${parsed.universe}`).to(`in${i + 1}-all`).emit('dmx-data', {
                protocol: i === 0 ? 'Entrada1' : 'Entrada2',
                input: i,
                proto: entrada.protocol,
                universe: parsed.universe,
                data: Array.from(parsed.data),
            });
        });

        sock.bind(port, addr, () => {
            stats.boundTo[i] = addr || '0.0.0.0';
            log(`[${INPUT_LABEL[i]}] ${entrada.protocol.toUpperCase()} escuchando en ${stats.boundTo[i]}:${port}`);

            if (entrada.protocol === 'sacn' && entrada.joinMulticast) {
                const from = Math.min(entrada.multicastFrom, entrada.multicastTo);
                const to = Math.min(Math.max(entrada.multicastFrom, entrada.multicastTo), from + 512);
                let joined = 0;
                for (let u = from; u <= to; u++) {
                    try {
                        sock.addMembership(dmx.sacnMulticastIp(u), addr);
                        joined++;
                    } catch (e) { /* grupo ya unido o sin soporte multicast */ }
                }
                stats.multicastGroups[i] = joined;
                log(`[${INPUT_LABEL[i]}] unido a ${joined} grupos multicast (universos ${from}-${to})`);
            }
        });

        inputSockets[i] = sock;
    }

    // ------------------------------------------------------------------- salida
    function rebindOut() {
        try { outSocket.close(); } catch (e) { /* ignorado */ }
        outSocket = dgram.createSocket('udp4');
        outSocket.on('error', (err) => { stats.lastSendError = err.message; });
        try {
            outSocket.bind(0, ifaceAddr(config.out.interface), () => {
                log(`[OUT] socket de salida en ${ifaceAddr(config.out.interface) || 'default'}`);
            });
        } catch (e) { /* ignorado */ }
        try { outSocket.setBroadcast(true); } catch (e) { /* ignorado */ }
    }

    function targetFor(universe) {
        const out = config.out;
        if (out.targetMode === 'broadcast') return '255.255.255.255';
        if (out.targetMode === 'unicast') return out.targetIp || '127.0.0.1';
        return out.protocol === 'sacn' ? dmx.sacnMulticastIp(universe) : (out.targetIp || '255.255.255.255');
    }

    const outPort = () => config.out.port || (config.out.protocol === 'artnet' ? artnetPort : sacnPort);

    function sendUniverse(universe, slots) {
        const visualizerUni = universe + (config.universeOffset || 0);
        const destIp = targetFor(visualizerUni);
        const key = `${config.out.protocol}:${universe}`;
        let seq = (sequences.get(key) || 0) + 1;
        if (seq > 255) seq = 0;
        sequences.set(key, seq);

        const packet = config.out.protocol === 'artnet'
            ? dmx.buildArtNetDmx(visualizerUni, slots, seq)
            : dmx.buildSacn(visualizerUni, slots, { cid: bridgeCid, sequence: seq, priority: 100 });

        if (config.out.targetMode === 'multicast' && config.out.protocol === 'sacn') {
            try {
                outSocket.setMulticastInterface(ifaceAddr(config.out.interface) || '0.0.0.0');
                outSocket.setMulticastTTL(32);
            } catch (e) { /* ignorado */ }
        }

        outSocket.send(packet, 0, packet.length, outPort(), destIp, (err) => {
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
        const merged = registry.unifiedAll('htp', config.merge.sources);
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
    function snapshot(now = Date.now()) {
        registry.purge(now);
        const merged = registry.unifiedAll('htp', config.merge.sources);
        const detail = {};
        for (const [uni, entry] of merged.entries()) {
            detail[uni] = { winner: entry.winner, present: entry.present };
        }
        for (let i = 0; i < 2; i++) stats.received[i].universos = registry.activeFor(i).length;
        return { merged, detail };
    }

    const stateTimer = setInterval(() => {
        const { merged, detail } = snapshot();
        io.emit('active-universes', {
            input1: registry.activeFor(0),
            input2: registry.activeFor(1),
            Unified: Array.from(merged.keys()),
        });
        io.emit('unified-info', detail);
        for (const [uni, entry] of merged.entries()) {
            io.to(`unified-${uni}`).to('unified-all').emit('dmx-data', {
                protocol: 'Unified', universe: uni, data: Array.from(entry.data),
            });
        }
    }, 500);

    const statsTimer = setInterval(() => io.emit('bridge-stats', stats), 2000);

    // ---------------------------------------------------------------- socket.io
    io.on('connection', (socket) => {
        log(`Cliente conectado: ${socket.id}`);
        socket.emit('bridge-config', config);
        socket.emit('bridge-stats', stats);
        const { detail } = snapshot();
        socket.emit('active-universes', {
            input1: registry.activeFor(0),
            input2: registry.activeFor(1),
            Unified: Array.from(registry.unifiedAll('htp', config.merge.sources).keys()),
        });
        socket.emit('unified-info', detail);

        socket.on('join-universe', (payload) => {
            let protocol = 'input1';
            let universeId = payload;
            if (typeof payload === 'object' && payload !== null) {
                protocol = payload.protocol;
                universeId = payload.universeId;
            }
            socket.rooms.forEach((room) => {
                if (/^(in1|in2|unified)-/.test(room)) socket.leave(room);
            });
            const prefix = protocol === 'Unified' ? 'unified' : (protocol === 'input2' ? 'in2' : 'in1');
            socket.join(`${prefix}-all`);
            if (universeId !== 'all') socket.join(`${prefix}-${universeId}`);
        });

        // Silenciar/dessilenciar un universo en una entrada (desde los chips del menú)
        socket.on('toggle-universe-mute', ({ input, universe }) => {
            const i = parseInt(input, 10);
            const u = parseInt(universe, 10);
            if (isNaN(i) || isNaN(u) || !config.inputs[i]) return;
            const muted = dmx.toggleMuted(config, i, u);
            // al silenciar, se descarta lo que ya estaba en el buffer de esa entrada
            if (muted) registry.sources[i].delete(u);
            io.emit('bridge-config', config);
            log(`[mute] ${INPUT_LABEL[i]} universo ${u} -> ${muted ? 'SILENCIADO' : 'activo'}`);
        });

        socket.on('get-network-interfaces', () => socket.emit('network-interfaces', listInterfaces()));
        socket.on('get-presets', () => socket.emit('presets-list', listPresets()));
        socket.on('update-bridge-config', (partial) => {
            applyConfig(partial);
            io.emit('bridge-config', config);
        });
        socket.on('save-preset', ({ name, config: presetConfig }) => {
            if (!name || !presetConfig) return;
            const safe = String(name).replace(/[^a-z0-9_-]/gi, '_');
            const normalized = dmx.normalizeConfig(presetConfig, dmx.DEFAULT_CONFIG);
            fs.writeFile(path.join(PRESETS_DIR, `${safe}.json`), JSON.stringify(normalized, null, 2), (err) => {
                if (!err) io.emit('presets-list', listPresets());
            });
        });
        socket.on('load-preset', (name) => {
            const safe = String(name).replace(/[^a-z0-9_-]/gi, '_');
            fs.readFile(path.join(PRESETS_DIR, `${safe}.json`), 'utf8', (err, raw) => {
                if (err) return;
                try {
                    applyConfig(JSON.parse(raw));
                    io.emit('bridge-config', config);
                } catch (e) {
                    console.error('Preset inválido:', e.message);
                }
            });
        });
        socket.on('disconnect', () => log(`Cliente desconectado: ${socket.id}`));
    });

    // -------------------------------------------------------------------- API
    app.get('/api/config', (req, res) => res.json({
        config,
        stats,
        interfaces: listInterfaces(),
        active: { input1: registry.activeFor(0), input2: registry.activeFor(1) },
    }));
    app.post('/api/config', (req, res) => {
        applyConfig(req.body || {});
        io.emit('bridge-config', config);
        res.json({ ok: true, config });
    });
    app.get('/api/stats', (req, res) => res.json({ stats }));
    app.post('/api/reset-stats', (req, res) => {
        stats.received = [{ paquetes: 0, universos: 0 }, { paquetes: 0, universos: 0 }];
        stats.sent = { artnet: 0, sacn: 0 };
        stats.droppedMuted = [0, 0];
        res.json({ ok: true });
    });
    // Silenciar por API (para automatizar / probar)
    app.post('/api/mute', (req, res) => {
        const i = parseInt(req.body.input, 10);
        const u = parseInt(req.body.universe, 10);
        if (isNaN(i) || isNaN(u) || !config.inputs[i]) return res.status(400).json({ ok: false, error: 'input/universe inválidos' });
        const muted = dmx.toggleMuted(config, i, u);
        if (muted) registry.sources[i].delete(u);
        io.emit('bridge-config', config);
        res.json({ ok: true, muted, config });
    });

    // ------------------------------------------------------------- config apply
    function applyConfig(partial) {
        const antes = config.inputs.map((e) => ({ protocol: e.protocol, enabled: e.enabled, interface: e.interface, from: e.multicastFrom, to: e.multicastTo }));
        const outIfaceAntes = config.out.interface;

        config = dmx.normalizeConfig(Object.assign({}, config, partial), dmx.DEFAULT_CONFIG);

        for (let i = 0; i < 2; i++) {
            const a = antes[i];
            const b = config.inputs[i];
            if (a.protocol !== b.protocol || a.enabled !== b.enabled || a.interface !== b.interface
                || a.from !== b.multicastFrom || a.to !== b.multicastTo) {
                bindInput(i);
            }
        }
        if (config.out.interface !== outIfaceAntes) rebindOut();
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
        bindInput(0);
        bindInput(1);
        rebindOut();
        return new Promise((resolve) => {
            server.listen(httpPort, '0.0.0.0', () => {
                log(`[+] Panel en http://localhost:${httpPort}`);
                log(`[+] Art-Net UDP ${artnetPort} · sACN UDP ${sacnPort}`);
                resolve({ httpPort, artnetInPort: artnetPort, sacnInPort: sacnPort });
            });
        });
    }

    function stop() {
        if (bridgeTimer) clearInterval(bridgeTimer);
        clearInterval(stateTimer);
        clearInterval(statsTimer);
        closeInput(0);
        closeInput(1);
        try { outSocket.close(); } catch (e) { /* ignorado */ }
        return new Promise((resolve) => {
            io.close(() => server.close(() => resolve()));
        });
    }

    return {
        app, server, io, registry, stats, start, stop,
        getConfig: () => config,
        applyConfig,
        dmx,
        DEFAULT_CONFIG: dmx.DEFAULT_CONFIG,
        ports: { httpPort, artnetInPort: artnetPort, sacnInPort: sacnPort },
    };
}

if (require.main === module) {
    const inst = createApp();
    inst.start().then(() => console.log('[+] Panel: http://localhost:' + inst.ports.httpPort));
}

module.exports = { createApp };
