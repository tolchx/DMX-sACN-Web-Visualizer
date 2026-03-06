const dgram = require('dgram');

const client = dgram.createSocket('udp4');
const port = 5568;
const host = '127.0.0.1';

// Base sACN (E1.31) packet structure
function createPacket(universe) {
    const buffer = Buffer.alloc(638);
    // Preamble Size
    buffer.writeUInt16BE(0x0010, 0);
    // Post-preamble Size
    buffer.writeUInt16BE(0x0000, 2);
    // ACN Packet Identifier
    buffer.write('ASC-E1.17\x00\x00\x00', 4, 12, 'utf8');

    // Flags + Length
    // Root Layer (length = 638 - 16 = 622 = 0x026e)
    // flag = 0x7000 | length. 0x7000 | 0x026e = 0x726e
    buffer.writeUInt16BE(0x726e, 16);

    // Vector (VECTOR_ROOT_E131_DATA)
    buffer.writeUInt32BE(0x00000004, 18);

    // CID (Sender UUID) - 16 bytes
    // Just some random bytes
    for (let i = 22; i < 38; i++) buffer[i] = i;

    // Framing Layer (length = 638 - 38 = 600 = 0x0258)
    buffer.writeUInt16BE(0x7258, 38);

    // Vector (VECTOR_E131_DATA_PACKET)
    buffer.writeUInt32BE(0x00000002, 40);

    // Source Name (64 bytes)
    buffer.write('Node Simulator', 44, 14, 'utf8');

    // Priority
    buffer.writeUInt8(100, 108);

    // Sync Address
    buffer.writeUInt16BE(0x0000, 109);

    // Sequence Number (Start at 0, incremented later if we wanted)
    buffer.writeUInt8(0, 111);

    // Options
    buffer.writeUInt8(0, 112);

    // Universe number
    buffer.writeUInt16BE(universe, 113);

    // DMP Layer (length = 638 - 115 = 523 = 0x020b)
    buffer.writeUInt16BE(0x720b, 115);

    // Vector (VECTOR_DMP_SET_PROPERTY)
    buffer.writeUInt8(0x02, 117);

    // Address Type & Data Type
    buffer.writeUInt8(0xa1, 118);

    // First Property Address
    buffer.writeUInt16BE(0x0000, 119);

    // Address Increment
    buffer.writeUInt16BE(0x0001, 121);

    // Property Value Count (512 slots + 1 start code = 513 = 0x0201)
    buffer.writeUInt16BE(0x0201, 123);

    // Start Code (125)
    buffer.writeUInt8(0x00, 125);

    // DMX values start at 126
    return buffer;
}


setInterval(() => {
    // Send to universe 1
    const p1 = createPacket(1);
    for (let i = 0; i < 512; i++) {
        p1[126 + i] = Math.floor(Math.random() * 255);
    }
    client.send(p1, port, host);

    // Send to universe 42
    const p2 = createPacket(42);
    const t = Date.now() / 500;
    for (let i = 0; i < 512; i++) {
        p2[126 + i] = Math.floor((Math.sin(t + i * 0.1) + 1) * 127);
    }
    client.send(p2, port, host);

    // Send to universe 96
    const p3 = createPacket(96);
    p3.fill(0, 126, 126 + 512); // turn off all
    p3[126 + 0] = 255;
    p3[126 + 511] = 255;
    client.send(p3, port, host);

}, 33); // ~30fps
