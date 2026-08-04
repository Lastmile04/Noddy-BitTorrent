// NOTE: Currently this is not a full fledged peer, this class is nore of a leecher(downloader), more functionality will be added in the future to make it into a complete peer that can leech(download) as well as seed(upload)
import EventEmitter from 'node:events';
import { computeSha1Hash } from '../identity/computeHash.js';
// This class can work normally for a proper bittorrent protocl but for MVP i need to expose the parseHandshake result
// handle the connect and peer object and onError() bugs resolve reject multiple times and no timeout for connect()
export class BitTorrentPeer extends EventEmitter {
    constructor(socket, peerId, protocolStr, peer, torrentMeta, timeout = 10_000) {
        super();
        this.socket = socket;
        this.infoHash = torrentMeta.infoHash;
        this.peerId = peerId;
        this.timeout = timeout;
        this.peer = peer;
        this.protocolStr = protocolStr;
        this.pieceCount = torrentMeta.pieceCount; // not needed  
        this.pieceLength = torrentMeta.pieceLength;
        this.pieceHashes = torrentMeta.pieceHashes; // not needed 
        this.lastPieceLength = torrentMeta.lastPieceLength; // not needed
        this.totalLength = torrentMeta.totalLength;
        this.targetPieceIdx = null; //not needed
        this.downloadedBytes = 0; // not needed
        this.nextRequestOffset = 0;


        this.ip = peer.ip;
        this.port = peer.port;


        // protocol state
        // NOTE: Since in MVP we're not really uploading any pieces so client will stay choked  
        this.choked = true;
        this.interested = false;
        this.bitfield = null;
        // Some pre-defined instances for later
        this.pendingRequests = new Map();
        this.incomingRequests = [];

        this.peerChoking = true;
        this.peerInterested = false;
        this.peerBitfield = null;

        this.buffer = Buffer.alloc(0);
        this.handshakeComplete = false;
        this.defaultBlockSize = 16 * 1024;

        // task specific instances 
        this.remotePeerId = null;
        this.connectTimeout = null;
        this.resolve = null;
        this.reject = null;
        this.finished = false;
        this.connectStarted = false;

        // attach transport handlers
        // bind the data events to "this" instance of this class then store the reference of these functions
        // in the usual method this.onConnect will refer to the inbuilt socket class not this BitTorrentPeer class  
        this.handleData = this.onData.bind(this);
        this.handleEnd = this.onEnd.bind(this);
        this.handleClose = this.onClose.bind(this);
        this.handleError = this.onError.bind(this);
        this.handleConnect = this.onConnect.bind(this);

        this.socket.on('error', (err) => {
            // prevent crash
            this.fail({
                type: "SOCKET_ERROR",
                message: err.message
            });

        });

        this.socket.on('close', () => {
            if (!this.finished) {
                this.fail({
                    type: "SOCKET_CLOSED",
                    message: "Socket closed unexpectedly"
                });
            }
        });

    }

    // to expose the result of peerHandshake
    connect() {
        if (this.connectStarted === true) throw new Error('The reuse of connect() instance is not allowed!');

        return new Promise((res, rej) => {
            this.connectStarted = true;
            this.resolve = res;
            this.reject = rej;
            this.finished = false;

            this.attachTransportHandlers();

            this.connectTimeout = setTimeout(() => {
                const err = new Error(`Handshake timeout for peer ${this.ip}:${this.port}`);
                err.type = 'PEER_TIMEOUT';
                this.fail(err);
            }, this.timeout);

            this.socket.connect(this.port, this.ip);
            this.emit("CONNECTING", { peer: `${this.ip}:${this.port}` });
        });
    }

    // attach listeners inside one function
    attachTransportHandlers() {

        this.socket.on('data', this.handleData);
        this.socket.once('end', this.handleEnd);
        this.socket.once('close', this.handleClose);
        this.socket.once('error', this.handleError);
        this.socket.once('connect', this.handleConnect);

    }

    // detach listener inside a single function
    detachTransportHandlers() {

        this.socket.off('data', this.handleData);
        this.socket.off('end', this.handleEnd);
        this.socket.off('close', this.handleClose);
        this.socket.off('error', this.handleError);
        this.socket.off('connect', this.handleConnect);

    }


    cleanup() {
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
        this.socket.setTimeout(0);
        this.detachTransportHandlers();
    }


    fail(err) {
        if (this.finished) return;
        this.finished = true;
        this.emit("ERROR", {
            peer: `${this.ip}:${this.port}`,
            type: err.type || "UNKNOWN",
            message: err.message || "Unknown error"
        });
        this.cleanup();
        this.socket.destroy();
        this.reject(err);
    }

    success() {
        if (!this.handshakeComplete || this.finished) return;
        this.finished = true;
        this.emit("PIECE_DOWNLOAD_SUCCESS", { index: this.targetPieceIdx, peer: this.peer });

        this.pieceBuffer = null;
        this.targetPieceIdx = null;
        this.downloadedBytes = 0;
        this.pendingRequests = new Map();
        this.nextRequestOffset = 0;

        this.cleanup();
        this.socket.destroy();
        this.resolve();
    }


    onConnect() {
        this.emit("CONNECT_SUCCESS", { peer: `${this.ip}:${this.port}` });
        this.sendHandshake();
    }


    // Bittorrent handshake format:
    // <pstrlen><pstr><reserved><infoHash><peerId>
    sendHandshake() {
        const pstr = this.protocolStr;
        const pstrlen = Buffer.from([pstr.length]);
        const reserved = Buffer.alloc(8);

        try {
            const handshake_msg = Buffer.concat([pstrlen, pstr, reserved, this.infoHash, this.peerId]);
            this.socket.write(handshake_msg);
            this.emit("HANDSHAKE_SENT", { peer: `${this.ip}:${this.port}` });
        } catch (err) {

            this.fail(err);

        }
    }

    onData(chunk) {
        if (this.finished) return;
        // Accumulate incoming bytes
        this.buffer = Buffer.concat([this.buffer, chunk]);
        // console.log('Buffer:', this.buffer);

        while (this.buffer.length > 0) {
            //  --- handshake phase ---
            if (!this.handshakeComplete) {

                if (this.buffer.length < 1) break;

                const receivedPstrLen = this.buffer[0];
                const handshakeLen = receivedPstrLen + 49;

                // wait until the full handshake is in the buffer
                if (this.buffer.length < handshakeLen) break;

                let parsed = 0;
                try {
                    // parse and verify
                    parsed = this.parseHandshake();
                    this.emit("HANDSHAKE_SUCCESS", parsed);
                    this.handshakeComplete = true;
                    if (this.handshakeComplete) clearTimeout(this.connectTimeout);
                } catch (err) {
                    this.fail(err);
                    return;
                }
                // consume only the handshake bytes
                this.buffer = this.buffer.slice(parsed.bytesConsumed);
            }
            //  --- massage parsing phase ---
            else {
                if (this.buffer.length < 4) break;

                const length = this.buffer.readUInt32BE(0);

                // handle keep alives
                if (length === 0) {
                    this.emit("KEEP_ALIVE");
                    this.buffer = this.buffer.slice(4);  // consume the length bytes only
                    continue;
                }

                const msgLen = 4 + length;
                if (this.buffer.length < msgLen) break;

                try {
                    const msgPayload = this.buffer.subarray(0, msgLen);
                    this.buffer = this.buffer.slice(msgLen);
                    const msg = this.parseMsg(msgPayload);
                    this.handleMsg(msg);
                }
                catch (err) {
                    this.fail(err);
                    return;
                }
            }
        }
    }

    // parese the response handshake
    parseHandshake() {

        const expectedPstrLen = this.protocolStr.length;
        const receivedPstrLen = this.buffer[0];

        // check protocol string length
        if (receivedPstrLen !== expectedPstrLen) {
            const err = new Error('protocol length mismatch');
            err.type = "protocol_mismatch";
            throw err;
        }

        const handshakeStart = 0;
        const handshakeEnd = expectedPstrLen + 49;
        const handshake = this.buffer.subarray(handshakeStart, handshakeEnd);

        const protocolStart = 1
        const protocolEnd = 1 + expectedPstrLen;
        const protocol = handshake.subarray(protocolStart, protocolEnd);

        // check protocol string
        if (!protocol.equals(this.protocolStr)) {
            const err = new Error('protocol mismatch');
            err.type = "protocol_mismatch";
            throw err;

        }

        const reservedStart = protocolEnd;
        const reservedEnd = reservedStart + 8;
        const infoHashStart = reservedEnd;
        const infoHashEnd = infoHashStart + 20;
        const peeridStart = infoHashEnd;
        const peeridEnd = peeridStart + 20;
        const totalHandshakeLength = peeridEnd;

        const remoteInfoHash = handshake.subarray(infoHashStart, infoHashEnd);
        const remotePeerId = handshake.subarray(peeridStart, peeridEnd);


        // check infohash
        if (!remoteInfoHash.equals(this.infoHash)) {
            const err = new Error('infoHash mismatch');
            err.type = "infoHash_mismatch";
            throw err;
        }

        this.remotePeerId = Buffer.from(remotePeerId);

        return {
            peer: this.peer,
            ip: this.ip,
            port: this.port,
            remotePeerId,
            remotePeerIdHex: remotePeerId.toString('hex'),
            handshake,
            bytesConsumed: totalHandshakeLength,
        };
    }

    parseMsg(msg) {

        const id = msg[4];
        let payload = Buffer.from(msg.subarray(5));
        switch (id) {
            case 0: return { type: "CHOKE" };
            case 1: return { type: "UNCHOKE" };
            case 2: return { type: "INTERESTED" };
            case 3: return { type: "NOT_INTERESTED" };
            case 4:
                if (payload.length !== 4) {
                    const err = new Error('Have length mismatch');
                    err.type = "msg_length_mismatch";
                    throw err;
                }
                return { type: "HAVE", pieceIndex: payload.readUInt32BE(0) };

            case 5:
                return {
                    type: "BITFIELD",
                    bitfield: payload,
                }
            case 6:

                if (payload.length !== 12) {
                    const err = new Error('Request length mismatch');
                    err.type = "msg_length_mismatch";
                    throw err;
                }
                return {
                    type: "REQUEST",
                    request: { index: payload.readUInt32BE(0), begin: payload.readUInt32BE(4), length: payload.readUInt32BE(8) },
                }
            case 7:
                if (payload.length < 8) {
                    const err = new Error('Piece length mismatch');
                    err.type = "msg_lenght_mismatch";
                    throw err;
                }
                return {
                    type: "PIECE",
                    piece: { index: payload.readUInt32BE(0), begin: payload.readUInt32BE(4), block: payload.subarray(8) },
                }
            case 8:

                if (payload.length !== 12) {
                    const err = new Error('Cancel length mismatch');
                    err.type = "msg_length_mismatch";
                    throw err;
                }
                return {
                    type: "CANCEL",
                    request: { index: payload.readUInt32BE(0), begin: payload.readUInt32BE(4), length: payload.readUInt32BE(8) },
                }
            default:
                return { type: "UNKNOWN", id }
        }
    }

    handleMsg(msgObj) {

        switch (msgObj.type) {
            case "CHOKE":
                this.peerChoking = true;
                // this.clearPendingRequests();
                // NOTE: For later ->clear pendingRequests 
                break;

            case "UNCHOKE":
                this.peerChoking = false;
                // NOTE: Hard coding block Size only for MVP for proper implementation use some other way since can't hardcode when the block size might be less
                const blockSize = 16 * 1024;
                this.emit("PEER_UNCHOKE");
                if (this.interested) this.sendRequest(blockSize);
                // start sending requests
                break;

            case "INTERESTED":
                this.peerInterested = true;
                break;

            case "NOT_INTERESTED":
                this.peerInterested = false;
                break;

            case "HAVE":
                //this.updatePeerBitfield(msgObj.pieceIndex);

                if (this.targetPieceIdx === null) {
                    const pieceIdx = this.findNeeded();
                    if (pieceIdx !== null) {
                        this.targetPieceIdx = pieceIdx;
                        // make sure to always derive calculation like these 
                        this.currentPieceLength = Math.min(this.pieceLength, (this.totalLength - (this.targetPieceIdx * this.pieceLength)));
                        this.pieceBuffer = Buffer.alloc(this.currentPieceLength);
                        this.sendInterested();
                    }
                }
                break;

            case "BITFIELD":
                this.peerBitfield = msgObj.bitfield;

                if (this.targetPieceIdx === null) {
                    const pieceIdx = this.findNeeded();
                    if (pieceIdx !== null) {
                        this.targetPieceIdx = pieceIdx;
                        this.currentPieceLength = Math.min(this.pieceLength, (this.totalLength - (this.targetPieceIdx * this.pieceLength)));
                        this.pieceBuffer = Buffer.alloc(this.currentPieceLength);
                        this.sendInterested();
                    }
                }
                break;

            case "REQUEST":
                // NOTE: in future the request will be pushed to the received requests array
                // NOTE: In Future TODO: make request working by implementing rarest first algorithm 
                this.incomingRequests.push(msgObj.request);
                break;

            case "PIECE":
                const { index, begin, block } = msgObj.piece;

                const key = `${this.targetPieceIdx}:${begin}`;
                if (!this.pendingRequests.has(key)) return;

                // NOTE: Because of the current status as MVP, to maintain correctness the constraints are a bit harsh
                if (this.targetPieceIdx !== index || begin !== this.downloadedBytes) {
                    return this.fail({
                        message: `Offset mismatch. Expected ${this.downloadedBytes}, got ${begin}`,
                        type: "PEER_BLOCK_MISMATCH"
                    });
                }

                let remainingBytes = this.currentPieceLength - this.downloadedBytes;
                if (block.length > remainingBytes) {
                    this.fail({
                        message: "Block exceeds remaining bytes for this piece",
                        type: "MALFORMED_RESPONSE"
                    });
                    return;
                }

                // copy from source               
                block.copy(this.pieceBuffer, begin);
                this.downloadedBytes += block.length;

                this.emit("BLOCK_RECEIVED", { index: index, begin: begin, blockLength: block.length });
                this.emit("PROGRESS", (this.downloadedBytes / this.currentPieceLength) * 100);

                this.pendingRequests.delete(key);

                // recalculate remaining bytes since we updated the downloadedBytes
                remainingBytes = this.currentPieceLength - this.downloadedBytes;

                if (remainingBytes > 0) {
                    const nextBlockSize = Math.min(remainingBytes, this.defaultBlockSize);
                    this.sendRequest(nextBlockSize);
                }
                else if (this.downloadedBytes === this.currentPieceLength) {
                    if (this.verifyPieceHash()) {
                        this.success();
                    }
                    else this.fail({ message: "Invalid hash", type: "HASH_FAIL" });
                }

                break;

            case "CANCEL":
                // NOTE: Not required for this MVP
                break;

            default:
                return { type: msgObj.type }
        }
    }

    verifyPieceHash() {
        const idx = this.targetPieceIdx;
        const pieceHash = computeSha1Hash(this.pieceBuffer);

        return this.pieceHashes[idx].equals(pieceHash);
    }
    // sendMessage(type, payload){}
    sendRequest(blockSize) {

        if (this.peerChoking || !this.interested) return;

        const begin = this.nextRequestOffset;
        if (this.pendingRequests.has(`${this.targetPieceIdx}:${begin}`)) return;
        const requestMsg = Buffer.alloc(17);

        requestMsg.writeUInt32BE(13, 0);                  // payload length
        requestMsg.writeUInt8(6, 4);                      // msgID 
        //payload
        requestMsg.writeUInt32BE(this.targetPieceIdx, 5); // index
        requestMsg.writeUInt32BE(begin, 9);               // begin
        requestMsg.writeUInt32BE(blockSize, 13);          // block length

        this.nextRequestOffset += blockSize;
        this.pendingRequests.set(`${this.targetPieceIdx}:${begin}`, blockSize);
        this.socket.write(requestMsg);
        this.emit("REQUEST_SENT", { index: this.targetPieceIdx, begin: begin, length: blockSize });
    }

    // since using fast fail approach there's no need for handling this.interested = true if socket closes immediately wihtout peer receiving the message
    sendInterested() {
        if (this.interested) return;

        const interestedMsg = Buffer.alloc(5);
        interestedMsg.writeUInt32BE(1, 0);
        interestedMsg.writeUInt8(2, 4);

        try {
            this.socket.write(interestedMsg);
            this.interested = true;
            this.emit('INTERESTED_QUEUED');

        } catch (err) {
            const error = {
                message: `Attempt to send Interested message to peer failed | ${err.message}`,
                type: 'INTERESTED_FAILED'
            }
            this.fail(error);

        }
    }

    findNeeded() {
        // NOTE: For MVP's sake we'll return as soon as we have a valid pieceCount instead of collecting all the valid pieceCounts in peer Bitfield
        for (let byteIdx = 0; byteIdx < this.peerBitfield.length; byteIdx++) {
            const peerByte = this.peerBitfield[byteIdx];
            const myByte = this.bitfield ? this.bitfield[byteIdx] : 0;
            // Since Bits are form 7->0
            for (let bit = 7; bit >= 0; bit--) {
                const pieceIndex = byteIdx * 8 + (7 - bit);
                if (pieceIndex >= this.pieceCount) break;

                // check the piece using bit mask
                const peerHas = (peerByte >> bit) & 1;
                const iHave = (myByte >> bit) & 1;
                if (peerHas && !iHave) return pieceIndex;
            }
        }
        return null;
    }


    onEnd() {
        if (!this.handshakeComplete) {
            const err = new Error(`peer ended stream before handshake: ${this.ip}:${this.port}`);
            err.type = "PEER_ERROR";
            this.fail(err);
            return;
        };
        this.emit("CONNECTION_CLOSED", {
            peer: `${this.ip}:${this.port}`
        });
    }

    onClose() {
        if (!this.handshakeComplete && !this.finished) {
            const err = new Error(`socket closed before handshake: ${this.ip}:${this.port}`);
            err.type = "SOCKET_ERROR";
            this.fail(err);
            return;
        }
        this.emit("SOCKET_CLOSED", {
            peer: `${this.ip}:${this.port}`
        });
    }

    onError(err) {
        this.fail(err);
    }
}
