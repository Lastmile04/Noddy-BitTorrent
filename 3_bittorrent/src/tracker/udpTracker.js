import dgram from 'dgram';
import crypto from 'crypto';
import dns from 'dns/promises';
import { Buffer } from 'buffer';
import { parseCompactPeers } from '../peers/peerParser.js';

// helper custom error classes
class TrackerTimeoutError extends Error {
    constructor(message = 'Tracker request timed out') {
        super(message);
        this.name = "TrackerTimeoutError";
        this.code = "ERR_TRACKER_TIMEOUT";
    }
}

class TrackerResponseError extends Error {
    constructor(message = 'Tracker returned error response') {
        super(message);
        this.name = "TrackerResponseError";
        this.code = "ERR_TRACKER_RESPONSE";
    }
}

class RetryExhaustedError extends Error {
    constructor(message = 'Retry limit exhausted', cause = null) {
        super(message);
        this.name = "RetryExhaustedError";
        this.code = "ERR_RETRY_EXHAUSTED";
        this.cause = cause;
    }
}

export async function udpPeer({ tracker, torrent, session }) {
    const addresses = await dns.lookup(tracker.hostname, { all: true });
    if (addresses.length === 0) throw new Error('Empty tracker list!');

    // Sort addresses to try IPv6 first, falling back to IPv4
    addresses.sort((a, b) => b.family - a.family);

    let addressLimit = Math.min(addresses.length, 3);

    for (let i = 0; i < addressLimit; i++) {
        let addr = addresses[i];
        let socket;
        try {
            socket = dgram.createSocket(addr.family === 6 ? "udp6" : "udp4");

            // send connect packet using resolved IP address
            const connectionId = await connect(socket, addr.address, tracker.port);

            const transport = {
                socket,
                connectionId
            }

            const resolvedTracker = {
                ...tracker,
                address: addr.address,
                family: addr.family
            }

            // send announce packet
            const peerINFO = await announce(resolvedTracker, transport, torrent, session);

            return parsePeers(peerINFO, addr.family);

        } catch (error) {
            if (error instanceof RetryExhaustedError) {
                console.log('address attempt failed, trying next address');
                continue;
            }
            if (error instanceof TrackerResponseError) {
                console.error('tracker explicitly rejected request');
                throw error;
            }

            throw error;

        } finally {
            if (socket) socket.close();
        }
    }
    throw new Error('All tracker addresses failed!');
}


function requestAttempt(socket, expectedAddress, port, attemptNum, packetInfo, classifier) {
    const { packet, txId } = packetInfo;
    const timeout = 15000 * 2 ** attemptNum;

    return new Promise((resolve, reject) => {
        let timer;
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            socket.off("message", msgListener);
            socket.off("error", errListener);
        };

        const doneResolve = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        const doneReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };

        const msgListener = (msg, rinfo) => {
            // Compare incoming packet source IP with the resolved tracker IP address
            if (rinfo.address !== expectedAddress || rinfo.port !== port) return;

            const type = classifier(msg, txId);

            switch (type) {
                case "error": {
                    let trackerMessage = "Tracker returned error response";
                    if (msg.length >= 8) trackerMessage = msg.subarray(8).toString("utf8");
                    return doneReject(new TrackerResponseError(trackerMessage));
                }
                case "ignore":
                    return;
                case "valid":
                    return doneResolve(msg);
                default:
                    return;
            }
        };

        const errListener = (err) => doneReject(err);

        socket.on("message", msgListener);
        socket.on("error", errListener);

        timer = setTimeout(() => {
            doneReject(new TrackerTimeoutError());
        }, timeout);

        socket.send(packet, port, expectedAddress, (err) => {
            if (err) doneReject(err);
        });
    });
}


// connect retry controller
async function connect(socket, expectedAddress, port) {
    let lastError;
    const attemptLimit = 8;
    for (let attemptNum = 0; attemptNum < attemptLimit; attemptNum++) {
        try {
            const packetInfo = buildConnect();

            const response = await requestAttempt(
                socket,
                expectedAddress,
                port,
                attemptNum,
                packetInfo,
                classifyConnectResponse,
            );
            return response.readBigUInt64BE(8);
        } catch (error) {
            lastError = error;
            if (error instanceof TrackerTimeoutError) continue; // retry
            if (error instanceof TrackerResponseError) throw error; // tracker failure
            throw error;
        }
    }

    throw new RetryExhaustedError('Connect retry exhausted', lastError);
}


function buildConnect() {
    const txId = crypto.randomBytes(4).readUInt32BE(0);
    const packet = Buffer.alloc(16);
    packet.writeBigUInt64BE(0x41727101980n, 0);
    packet.writeUInt32BE(0, 8)
    packet.writeUInt32BE(txId, 12);
    return { packet, txId };
}


function classifyConnectResponse(msg, txId) {
    if (msg.length < 8) return 'ignore';

    const action = msg.readUInt32BE(0);
    const transaction = msg.readUInt32BE(4);

    if (transaction !== txId) return 'ignore';
    if (action === 3) return 'error';
    if (action === 0 && msg.length >= 16) return 'valid';

    return 'ignore';
}


// --------annouce------------

async function announce(tracker, transport, torrent, session) {
    let lastError;
    const attemptLimit = 8;
    const torrentData = {
        infoHash: torrent.infoHash,
        peerId: torrent.peerId
    }
    for (let attemptNum = 0; attemptNum < attemptLimit; attemptNum++) {
        try {
            const packetInfo = buildAnnounce(transport.connectionId, torrentData, session);
            const classifier = (msg, txId) => classifyAnnounceResponse(msg, txId, tracker.family);

            const announceResponse = await requestAttempt(
                transport.socket,
                tracker.address, // ✅ Using resolved IP address instead of hostname string
                tracker.port,
                attemptNum,
                packetInfo,
                classifier
            );

            return announceResponse;
        } catch (error) {
            lastError = error;
            if (error instanceof TrackerTimeoutError) continue; // retry

            throw error;
        }
    }

    throw new RetryExhaustedError('Announce retry exhausted', lastError);
}


function buildAnnounce(connectionId, torrent, session) {
    const { infoHash, peerId } = torrent;
    const { downloaded, left, uploaded, event, numwant, port } = session;

    const key = crypto.randomBytes(4);
    const txId = crypto.randomBytes(4).readUInt32BE(0);

    let packet = Buffer.alloc(98);
    packet.writeBigUInt64BE(connectionId, 0);
    packet.writeUInt32BE(1, 8); // action: 1 for announce
    packet.writeUInt32BE(txId, 12);
    infoHash.copy(packet, 16);
    peerId.copy(packet, 36);
    packet.writeBigUInt64BE(BigInt(downloaded), 56);
    packet.writeBigUInt64BE(BigInt(left), 64);
    packet.writeBigUInt64BE(BigInt(uploaded), 72);
    packet.writeUInt32BE(event, 80);
    packet.writeUInt32BE(0, 84);
    key.copy(packet, 88);
    packet.writeUInt32BE(numwant === -1 ? 0xFFFFFFFF : numwant, 92);
    packet.writeUInt16BE(port, 96);

    return { packet, txId };
}


function classifyAnnounceResponse(msg, txId, family) {
    if (msg.length < 8) return "ignore";

    const action = msg.readUInt32BE(0);
    const transactionId = msg.readUInt32BE(4);

    if (transactionId !== txId) return "ignore"
    if (action === 3) return "error";
    if (action === 1) {
        if (msg.length < 20) return "ignore";

        const peerBytes = msg.length - 20;

        if (family === 4 && peerBytes % 6 === 0) return "valid";
        if (family === 6 && peerBytes % 18 === 0) return "valid";
    }
    return "ignore";
}


function parsePeers(res, family) {
    const interval = res.readUInt32BE(8);
    const leechers = res.readUInt32BE(12);
    const seeders = res.readUInt32BE(16);
    const peers = parseCompactPeers(family, res.subarray(20));

    return { interval, seeders, leechers, peers, peerNum: peers.length };
}
