const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const dgram = require('dgram');
const path = require('path');
const localtunnel = require('localtunnel');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ==== STATE ====
let currentMode = 'IDLE'; // 'IDLE', 'HOST', 'JOIN'
let sacnReceiver = null;
let sacnSender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let tunnelInstance = null;
let clientSocket = null;

let stats = {
    packetsReceivedTotal: 0,
    packetsSentTotal: 0,
    activeUniverses: new Set()
};

// ==== HOST MODE (SERVER) ====
function startHost() {
    if (currentMode !== 'IDLE') return false;
    currentMode = 'HOST';

    // Start listening to local sACN Multicast
    sacnReceiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sacnReceiver.on('listening', () => {
        // Join Multicast groups for Universes 1 to 100 (This covers 96+ universes easily)
        for (let i = 1; i <= 100; i++) {
            try {
                sacnReceiver.addMembership(`239.255.0.${i}`);
            } catch (err) {
                // Ignore if interface doesn't support multicast
            }
        }
        const address = sacnReceiver.address();
        console.log(`[HOST] Listening for local sACN on ${address.address}:${address.port}`);
    });

    sacnReceiver.on('message', (msg, rinfo) => {
        // Basic sACN validation
        if (msg.length < 126) return;
        const protocolId = msg.toString('utf8', 4, 16);
        if (!protocolId.startsWith('ASC-E1.17')) return;

        const universe = msg.readUInt16BE(113);
        stats.activeUniverses.add(universe);
        stats.packetsReceivedTotal++;

        // Broadcast raw buffer to all connected WebSockets
        // Using `volatile` means if the connection is slow, it will drop packets instead of buffering them (prevents lag buildup)
        io.volatile.emit('sacn-forward', { universe, data: msg });
        // Removed per-packet UI update to save CPU/Event loop (now handled by setInterval)
    });

    sacnReceiver.bind(5568);
    return true;
}

function stopHost() {
    if (sacnReceiver) {
        try { sacnReceiver.close(); } catch (e) { }
        sacnReceiver = null;
    }
    if (tunnelInstance) {
        tunnelInstance.close();
        tunnelInstance = null;
    }
    currentMode = 'IDLE';
    io.local.emit('status', { mode: 'IDLE' });
}

// ==== JOIN MODE (CLIENT) ====
function startJoin(targetUrl) {
    if (currentMode !== 'IDLE') return false;
    currentMode = 'JOIN';

    clientSocket = ioClient(targetUrl, {
        extraHeaders: {
            "Bypass-Tunnel-Reminder": "true"
        }
    });

    clientSocket.on('connect', () => {
        console.log(`[JOIN] Connected to Host at ${targetUrl}`);
        io.local.emit('status', { mode: 'JOIN', connected: true, url: targetUrl });
    });

    clientSocket.on('sacn-forward', (payload) => {
        const { universe, data } = payload;
        const buffer = Buffer.from(data);

        // Broadcast the received sACN buffer locally using Multicast AND Unicast
        const multicastAddress = `239.255.${Math.floor(universe / 256)}.${universe % 256}`;

        // 1. Send Multicast (Standard sACN)
        sacnSender.send(buffer, 0, buffer.length, 5568, multicastAddress, (err) => {
            if (err) console.error("Error sending local multicast:", err);
        });

        // 2. Send Unicast to localhost (Crucial for Unreal Engine if listening on 127.0.0.1)
        sacnSender.send(buffer, 0, buffer.length, 5568, '127.0.0.1', (err) => {
            if (!err) {
                stats.packetsSentTotal++;
                stats.activeUniverses.add(universe);
                // Removed per-packet UI update to save CPU/Event loop (now handled by setInterval)
            } else {
                console.error("Error sending local unicast:", err);
            }
        });
    });

    clientSocket.on('disconnect', () => {
        console.log('[JOIN] Disconnected from Host');
        io.local.emit('status', { mode: 'JOIN', connected: false });
    });

    return true;
}

function stopJoin() {
    if (clientSocket) {
        clientSocket.disconnect();
        clientSocket = null;
    }
    currentMode = 'IDLE';
    io.local.emit('status', { mode: 'IDLE' });
}


// ==== REAL-TIME STATS ====
function getStats() {
    return {
        mode: currentMode,
        packetsReceivedTotal: stats.packetsReceivedTotal,
        packetsSentTotal: stats.packetsSentTotal,
        activeUniverses: Array.from(stats.activeUniverses)
    };
}

setInterval(() => {
    // Clear active universes periodically
    stats.activeUniverses.clear();
}, 2000);

setInterval(() => {
    // Update local UI periodically instead of every packet to prevent Event Loop blockage
    if (currentMode !== 'IDLE') {
        io.local.emit('stats-update', getStats());
    }
}, 300); // UI updates ~3 times per second


// ==== WEBSOCKET UI CONTROLS ====
io.on('connection', (socket) => {
    // Send initial state to the UI
    socket.emit('status', { mode: currentMode });
    socket.emit('stats-update', getStats());

    // UI Commands
    socket.on('ui-start-host', async () => {
        if (startHost()) {
            socket.emit('status', { mode: 'HOST' });
        }
    });

    socket.on('ui-generate-link', async () => {
        if (currentMode !== 'HOST') return;
        try {
            tunnelInstance = await localtunnel({ port: PORT });
            socket.emit('tunnel-url', { url: tunnelInstance.url });

            tunnelInstance.on('close', () => {
                socket.emit('tunnel-url', { url: null });
            });
        } catch (err) {
            console.error("LocalTunnel Error:", err);
            socket.emit('tunnel-url', { error: "Failed to generate public link" });
        }
    });

    socket.on('ui-stop-host', () => {
        stopHost();
    });

    socket.on('ui-start-join', (data) => {
        if (startJoin(data.url)) {
            socket.emit('status', { mode: 'JOIN', connected: false, url: data.url });
        }
    });

    socket.on('ui-stop-join', () => {
        stopJoin();
    });
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[+] Web Tunnel UI running at http://localhost:${PORT}`);
});
