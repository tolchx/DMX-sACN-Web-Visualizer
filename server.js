const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Use native dgram for robust UDP receiving
const sacnServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const artNetServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

// Track activities independently
const activity = {
    sACN: new Map(),
    ArtNet: new Map()
};

// --- BRIDGE CONFIGURATION & STATIC BUFFER ---
let bridgeConfig = {
    enabled: false,
    outInterface: '', // IP string of the interface to bind to
    targetIp: '127.0.0.1'
};
let bridgeOutSocket = dgram.createSocket('udp4');

const bridgeCid = crypto.randomBytes(16);
const sacnSendBuffer = Buffer.alloc(638, 0);
const sacnSequenceNumbers = new Map();

// Root Layer
sacnSendBuffer.writeUInt16BE(0x0010, 0);
sacnSendBuffer.writeUInt16BE(0x0000, 2);
sacnSendBuffer.write("ASC-E1.17\x00\x00\x00", 4, 12, 'ascii');
sacnSendBuffer.writeUInt16BE(0x726e, 16);
sacnSendBuffer.writeUInt32BE(0x00000004, 18);
bridgeCid.copy(sacnSendBuffer, 22);
// Framing Layer
sacnSendBuffer.writeUInt16BE(0x7258, 38);
sacnSendBuffer.writeUInt32BE(0x00000002, 40);
sacnSendBuffer.write("Web DMX/sACN Bridge", 44, 64, 'utf8');
sacnSendBuffer.writeUInt8(100, 108); // Priority
sacnSendBuffer.writeUInt16BE(0x0000, 109); // Sync Address
sacnSendBuffer.writeUInt8(0, 111); // Seq
sacnSendBuffer.writeUInt8(0, 112); // Options
sacnSendBuffer.writeUInt16BE(1, 113); // Universe
// DMP Layer
sacnSendBuffer.writeUInt16BE(0x720b, 115);
sacnSendBuffer.writeUInt8(0x02, 117);
sacnSendBuffer.writeUInt8(0xa1, 118);
sacnSendBuffer.writeUInt16BE(0x0000, 119);
sacnSendBuffer.writeUInt16BE(0x0001, 121);
sacnSendBuffer.writeUInt16BE(0x0201, 123);
sacnSendBuffer.writeUInt8(0, 125); // Start Code


// --- sACN RECEIVER ---
sacnServer.on('message', (msg, rinfo) => {
    try {
        if (msg.length < 126) return;
        const protocolId = msg.toString('utf8', 4, 16);
        if (!protocolId.startsWith('ASC-E1.17')) return;

        const universe = msg.readUInt16BE(113);
        const slotsData = msg.slice(126, Math.min(msg.length, 126 + 512));

        activity.sACN.set(universe, Date.now());

        io.to(`sacn-${universe}`).to('sacn-all').emit('dmx-data', {
            protocol: 'sACN',
            universe: universe,
            data: Array.from(slotsData)
        });
    } catch (e) { }
});
sacnServer.bind(5568);

// --- ART-NET RECEIVER ---
artNetServer.on('message', (msg, rinfo) => {
    try {
        if (msg.length < 18) return;
        // Art-Net packet signature
        if (msg.toString('utf8', 0, 7) !== 'Art-Net') return;
        // OpDmx opcode is 0x5000 (Little Endian -> 0x00 0x50)
        const opCode = msg.readUInt16LE(8);
        if (opCode !== 0x5000) return;

        // SubUni (Universe identifier)
        const universe = msg.readUInt16LE(14);
        const length = msg.readUInt16BE(16);
        const slotsData = msg.slice(18, 18 + length);

        activity.ArtNet.set(universe, Date.now());

        io.to(`artnet-${universe}`).to('artnet-all').emit('dmx-data', {
            protocol: 'ArtNet',
            universe: universe,
            data: Array.from(slotsData)
        });

        // --- BRIDGE: Fast Buffer Conversion ---
        if (bridgeConfig.enabled && bridgeConfig.targetIp) {
            // Update Universe
            sacnSendBuffer.writeUInt16BE(universe, 113);

            // Advance Seq
            let seq = (sacnSequenceNumbers.get(universe) || 0) + 1;
            if (seq > 255) seq = 0;
            sacnSequenceNumbers.set(universe, seq);
            sacnSendBuffer.writeUInt8(seq, 111);

            // Copy DMX data directly to static buffer (blazing fast RAM copy)
            const copyLen = Math.min(slotsData.length, 512);
            slotsData.copy(sacnSendBuffer, 126, 0, copyLen);
            if (copyLen < 512) sacnSendBuffer.fill(0, 126 + copyLen, 126 + 512);

            // Send asynchronously Unicast
            bridgeOutSocket.send(sacnSendBuffer, 0, sacnSendBuffer.length, 5568, bridgeConfig.targetIp);
        }

    } catch (e) { }
});
artNetServer.bind(6454);

// Periodically broadcast which universes are active
setInterval(() => {
    const now = Date.now();

    // Cleanup & Gather sACN
    const active_sACN = [];
    for (const [uni, lastTime] of activity.sACN.entries()) {
        if (now - lastTime < 2000) {
            active_sACN.push(uni);
        } else {
            activity.sACN.delete(uni);
        }
    }

    // Cleanup & Gather ArtNet
    const active_ArtNet = [];
    for (const [uni, lastTime] of activity.ArtNet.entries()) {
        if (now - lastTime < 2000) {
            active_ArtNet.push(uni);
        } else {
            activity.ArtNet.delete(uni);
        }
    }

    io.emit('active-universes', {
        sACN: active_sACN.sort((a, b) => a - b),
        ArtNet: active_ArtNet.sort((a, b) => a - b)
    });
}, 500);

// Client Connection Handling
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Give them the immediate active list
    socket.emit('active-universes', {
        sACN: Array.from(activity.sACN.keys()).sort((a, b) => a - b),
        ArtNet: Array.from(activity.ArtNet.keys()).sort((a, b) => a - b)
    });

    socket.on('join-universe', (payload) => {
        // Support backwards compatibility incase payload is just a number/string
        let protocol = 'sACN';
        let universeId = payload;

        if (typeof payload === 'object') {
            protocol = payload.protocol;
            universeId = payload.universeId;
        }

        // Leave all old routing rooms
        socket.rooms.forEach(room => {
            if (room.startsWith('sacn-') || room.startsWith('artnet-')) {
                socket.leave(room);
            }
        });

        const prefix = protocol.toLowerCase(); // 'sacn' or 'artnet'

        // Always join the 'all' room for minimap updates of the selected protocol
        socket.join(`${prefix}-all`);

        // Join specific room if not global
        if (universeId !== 'all') {
            socket.join(`${prefix}-${universeId}`);
            console.log(`Client ${socket.id} started monitoring ${protocol} Universe ${universeId}`);
        } else {
            console.log(`Client ${socket.id} started monitoring ALL ${protocol} Universes`);
        }
    });

    // Bridge Settings Socket handlers
    socket.emit('bridge-config', bridgeConfig);

    socket.on('get-network-interfaces', () => {
        const nets = os.networkInterfaces();
        const results = [];
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                // Return IPv4 non-internal interfaces
                if (net.family === 'IPv4' && !net.internal) {
                    results.push({ name: name, address: net.address });
                }
            }
        }
        socket.emit('network-interfaces', results);
    });

    socket.on('update-bridge-config', (config) => {
        const oldInterface = bridgeConfig.outInterface;
        bridgeConfig = { ...bridgeConfig, ...config };

        // Re-bind outgoing socket if IP changed
        if (bridgeConfig.outInterface && bridgeConfig.outInterface !== oldInterface) {
            try { bridgeOutSocket.close(); } catch (e) { }
            bridgeOutSocket = dgram.createSocket('udp4');
            try {
                bridgeOutSocket.bind(0, bridgeConfig.outInterface, () => {
                    console.log(`Bridge Outbound bound to ${bridgeConfig.outInterface}`);
                });
            } catch (e) {
                console.error("Failed to bind outbound socket:", e);
            }
        }

        io.emit('bridge-config', bridgeConfig);
        console.log("Bridge Config Updated:", bridgeConfig);
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[+] sACN/Art-Net Web Visualizer is live at http://localhost:${PORT}`);
    console.log(`[+] Listening for sACN on UDP port 5568`);
    console.log(`[+] Listening for Art-Net on UDP port 6454`);
});
