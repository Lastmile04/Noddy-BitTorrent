import EventEmitter from "node:events";
import * as net from 'net';
import { HandshakeResult, PeerConfig, PeerState, BT_PROTOCOL_LEN, BT_PROTOCOL_BUFFER, PeerMessage, RequestState } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";
import { LifecycleStateOpts } from "./types.js";
export class BitTorrentPeer extends EventEmitter {

    remotePeerState: PeerState;
    socket: net.Socket;
    peerId: Buffer;
    infoHash: Buffer;
    pieceLength: number;
    totalLength: number;
    handshakeComplete: boolean;
    HANDSHAKE_TIMEOUT: number;
    connectTimeout?: NodeJS.Timeout;
    bufQueue: Buffer[];
    bufferedBytes: number;
    lastPeerActive?: number;
    handledFailure: boolean;
    lifecycleState: LifecycleStateOpts;
    connectResolve?: () => void;
    connectReject?: (reason: Error) => void;
    pieceCount: number;
    MAX_FRAME_SIZE: number;
    private outstandingRequests: Map<string, RequestState>;

    constructor({
        socket,
        peer,
        peerId,
        infoHash,
        pieceLength,
        totalLength,
        pieceCount
    }: PeerConfig) {

        super();
        this.socket = socket;
        this.peerId = peerId;
        this.infoHash = infoHash;
        this.pieceLength = pieceLength;
        this.totalLength = totalLength;
        this.handshakeComplete = false;
        this.HANDSHAKE_TIMEOUT = 10000;
        this.connectTimeout = undefined;
        this.bufQueue = [];
        this.bufferedBytes = 0;
        this.lastPeerActive = undefined;
        this.handledFailure = false;
        this.lifecycleState = 'NEW';
        this.connectResolve = undefined;
        this.connectReject = undefined;
        this.pieceCount = pieceCount;
        this.MAX_FRAME_SIZE = 1048576;
        this.outstandingRequests = new Map();

        this.remotePeerState = {
            ip: peer.ip,
            port: peer.port,
            remotePeerId: undefined,

            amChoking: true,
            amInterested: false,
            peerChoking: true,
            peerInterested: false,

            bitfield: undefined,
            downloadRate: 0
        };
    }

    // --- Arrow Function Event Handlers ---

    handleData = (data: Buffer): void => {
        this.onData(data);
    };

    handleEnd = (): void => {
        this.onEnd();
    };

    handleClose = (): void => {
        this.onClose();
    };

    handleError = (err: Error): void => {
        this.onError(err);
    };

    handleConnect = (): void => {
        this.onConnect();
    };

    // --- Transport Listener Binding ---

    attachTransportHandlers(): void {
        this.socket.on('data', this.handleData);
        this.socket.once('end', this.handleEnd);
        this.socket.once('close', this.handleClose);
        this.socket.once('error', this.handleError);
        this.socket.once('connect', this.handleConnect);
    }

    detachTransportHandlers(): void {
        this.socket.off('data', this.handleData);
        this.socket.off('end', this.handleEnd);
        this.socket.off('close', this.handleClose);
        this.socket.off('error', this.handleError);
        this.socket.off('connect', this.handleConnect);
    }

    // --- Internal Class Handlers ---

    public connect(): Promise<void> {
        if (this.lifecycleState === 'NEW') {
            return new Promise<void>((res, rej) => {
                this.connectResolve = res;
                this.connectReject = rej;
                this.lifecycleState = 'CONNECTING';

                this.attachTransportHandlers();

                this.connectTimeout = setTimeout(() => {
                    this.fail(ErrorFactory.network(
                        'HANDSHAKE_TIMEOUT',
                        `Handshake timeout for peer ${this.remotePeerState.ip}:${this.remotePeerState.port}`,
                    ));
                }, this.HANDSHAKE_TIMEOUT);
                this.socket.connect(this.remotePeerState.port, this.remotePeerState.ip);
                this.emit('CONNECTING', { peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}` });
            });
        } else {
            throw ErrorFactory.peer_state(
                'INVALID_STATE_TRANSITION',
                "The caller asked this peer to perform an operation that isn't valid in its current state",
            );
        }
    }

    private onConnect(): void {
        this.lifecycleState = 'CONNECTED';
        this.emit('CONNECT_SUCCESS', { peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}` });
        this.sendHandshake();
    }

    private sendHandshake(): void {
        const reserved = Buffer.alloc(8);
        const pstrLenBuf = Buffer.from([BT_PROTOCOL_LEN]);

        try {
            const handshakeMsg = Buffer.concat([
                pstrLenBuf,
                BT_PROTOCOL_BUFFER,
                reserved,
                this.infoHash,
                this.peerId,
            ]);

            this.socket.write(handshakeMsg);
            this.emit("HANDSHAKE_SENT", { peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}` });
        } catch (err) {
            this.fail(ErrorFactory.fromSocketError(err));
        }
    }

    private onData(chunk: Buffer): void {
        this.bufQueue.push(chunk);
        this.bufferedBytes += chunk.length;

        while (this.bufferedBytes > 0) {
            if (!this.handshakeComplete) {
                if (this.bufferedBytes < 1) break;

                const receivedPstrLen = this.bufQueue[0][0];
                if (receivedPstrLen !== BT_PROTOCOL_LEN) {
                    this.fail(
                        ErrorFactory.network(
                            'PROTOCOL_VIOLATION',
                            'Invalid protocol length',
                            {
                                originalLength: BT_PROTOCOL_LEN,
                                receivedPstrLen: receivedPstrLen
                            }
                        )
                    );
                    return;
                }

                const handshakeLen = receivedPstrLen + 49;
                if (this.bufferedBytes < handshakeLen) break;

                try {
                    const fullBuf = this.consumeBytes(handshakeLen);
                    const parsed = this.parseHandshake(fullBuf);
                    this.handshakeComplete = true;
                    this.lifecycleState = 'READY';

                    if (this.connectTimeout) clearTimeout(this.connectTimeout);
                    this.emit("HANDSHAKE_SUCCESS", parsed);

                    if (this.connectResolve) {
                        this.connectResolve();
                        this.connectResolve = undefined;
                        this.connectReject = undefined;
                    }

                } catch (err) {
                    this.fail(ErrorFactory.normalize(err));
                    return;
                }
            } else {
                if (this.bufferedBytes < 4) break;

                const messageLength = this.peekUInt32BE();

                if (messageLength > this.MAX_FRAME_SIZE) {
                    this.fail(
                        ErrorFactory.network(
                            'EXCESSIVE_FRAME_SIZE',
                            `Peer advertised message length (${messageLength} bytes) exceeding maximum allowed limit`
                        )
                    );
                    return;
                }

                const totalMsgLen = 4 + messageLength;
                if (this.bufferedBytes < totalMsgLen) break;

                const msgBuf = this.consumeBytes(totalMsgLen).subarray(4);

                try {
                    const msgObj = this.parseMsg(msgBuf);
                    this.handlePeerMessage(msgObj);
                } catch (err) {
                    this.fail(ErrorFactory.normalize(err));
                    return;
                }
            }
        }
    }

    private onEnd(): void {
        this.emit('CONNECTION_CLOSED');
    }

    private onClose(): void {
        if (!this.handshakeComplete && !this.handledFailure) {
            this.fail(
                ErrorFactory.socket(
                    'HANDSHAKE_INCOMPLETE',
                    'Socket closed even though handshake is incomplete'
                )
            );
        }

        this.dropOutstandingRequests();

        if (this.lifecycleState !== 'FAILED') this.lifecycleState = 'CLOSED';
        this.emit("SOCKET_CLOSED", {
            peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}`
        });
    }

    private onError(err: Error): void {
        this.fail(ErrorFactory.fromSocketError(err));
    }

    private fail(err: Error): void {
        if (this.lifecycleState === 'FAILED' || this.lifecycleState === 'CLOSED') return;

        this.lifecycleState = 'FAILED';
        this.handledFailure = true;

        this.dropOutstandingRequests();
        this.cleanup();

        if (this.socket && !this.socket.destroyed) this.socket.destroy();
        if (this.connectReject) this.connectReject(err);

        this.connectReject = undefined;
        this.connectResolve = undefined;

        this.emit("error", err);
    }

    // --- Helper functions And State Update Methods ---

    private cleanup(): void {
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }
        this.socket.setTimeout(0);
        this.detachTransportHandlers();
    }

    private peekUInt32BE(): number {
        if (this.bufQueue[0].length >= 4) {
            return this.bufQueue[0].readUInt32BE(0);
        }
        const tempHeader = this.peekBytes(4);
        return tempHeader.readUInt32BE(0);
    }

    private peekBytes(count: number): Buffer {
        let remaining = count;
        const res: Buffer[] = [];

        for (const chunk of this.bufQueue) {
            if (chunk.length >= remaining) {
                res.push(chunk.subarray(0, remaining));
                break;
            }
            res.push(chunk);
            remaining -= chunk.length;
        }
        return Buffer.concat(res);
    }

    private consumeBytes(count: number): Buffer {
        const res: Buffer[] = [];
        let fetched = 0;

        while (this.bufQueue.length > 0 && fetched < count) {
            const head = this.bufQueue[0];
            const needed = count - fetched;

            if (head.length <= needed) {
                res.push(this.bufQueue.shift()!);
                fetched += head.length;
            } else {
                res.push(head.subarray(0, needed));
                this.bufQueue[0] = head.subarray(needed);
                fetched += needed;
            }
        }
        this.bufferedBytes -= count;
        return res.length === 1 ? res[0] : Buffer.concat(res);
    }

    private parseHandshake(buf: Buffer): HandshakeResult {
        const receivedPstrLen = buf[0];

        if (receivedPstrLen !== BT_PROTOCOL_LEN) {
            throw ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                'Invalid protocol length',
                {
                    originalLength: BT_PROTOCOL_LEN,
                    receivedPstrLen: receivedPstrLen
                }
            );
        }

        const receivedPstr = buf.subarray(1, 1 + receivedPstrLen);
        if (!receivedPstr.equals(BT_PROTOCOL_BUFFER)) {
            throw ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                'Protocol string mismatch',
                {
                    originalBuf: BT_PROTOCOL_BUFFER,
                    receivedBuf: receivedPstr
                }
            );
        }

        const reservedOffset = 1 + receivedPstrLen;
        const reserved = buf.subarray(reservedOffset, reservedOffset + 8);

        const infoHashOffset = reservedOffset + 8;
        const receivedInfoHash = buf.subarray(infoHashOffset, infoHashOffset + 20);

        if (!receivedInfoHash.equals(this.infoHash)) {
            throw ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                'InfoHash mismatch',
                {
                    originalInfoHash: this.infoHash,
                    receivedInfoHash: receivedInfoHash
                },
            );
        }

        const peerIdOffset = infoHashOffset + 20;
        const receivedPeerId = buf.subarray(peerIdOffset, peerIdOffset + 20);

        this.remotePeerState.remotePeerId = receivedPeerId;
        const totalHandshakeBytes = peerIdOffset + 20;

        return {
            bytesConsumed: totalHandshakeBytes,
            pstr: receivedPstr.toString("utf8"),
            reserved,
            infoHash: receivedInfoHash,
            peerId: receivedPeerId
        };
    }

    private parseMsg(msg: Buffer): PeerMessage {
        if (msg.length === 0) return { type: "KEEP_ALIVE" };

        const id = msg[0];
        const payload = msg.subarray(1);

        switch (id) {
            case 0: return { type: "CHOKE" };
            case 1: return { type: "UNCHOKE" };
            case 2: return { type: "INTERESTED" };
            case 3: return { type: "UNINTERESTED" };

            case 4:
                if (payload.length !== 4) throw new Error("Have length mismatched");
                return { type: "HAVE", pieceIndex: payload.readUInt32BE(0) };

            case 5:
                return { type: "BITFIELD", bitfield: payload };

            case 6:
                if (payload.length !== 12) throw new Error("Request length mismatch");
                return {
                    type: "REQUEST",
                    index: payload.readUInt32BE(0),
                    begin: payload.readUInt32BE(4),
                    length: payload.readUInt32BE(8)
                };

            case 7:
                if (payload.length < 8) throw new Error("Piece length mismatch");
                return {
                    type: "PIECE",
                    index: payload.readUInt32BE(0),
                    begin: payload.readUInt32BE(4),
                    block: payload.subarray(8)
                };

            case 8:
                if (payload.length !== 12) throw new Error("Cancel length mismatch");
                return {
                    type: "CANCEL",
                    index: payload.readUInt32BE(0),
                    begin: payload.readUInt32BE(4),
                    length: payload.readUInt32BE(8)
                };

            default:
                this.fail(
                    ErrorFactory.network(
                        'PROTOCOL_VIOLATION',
                        'Unknown message received form peer',
                        { block: msg, id }
                    )
                );
                return { type: 'UNKNOWN', id };
        }
    }

    private hasReceivedFirstMsg: boolean = false;

    private handlePeerMessage(msgObj: PeerMessage): void {

        switch (msgObj.type) {
            case "KEEP_ALIVE":
                this.lastPeerActive = Date.now();
                break;

            case "CHOKE":
                this.remotePeerState.peerChoking = true;
                this.lastPeerActive = Date.now();
                this.dropOutstandingRequests();
                this.emit("choke");
                break;

            case "UNCHOKE":
                this.remotePeerState.peerChoking = false;
                this.lastPeerActive = Date.now();
                this.emit("unchoke");
                break;

            case "INTERESTED":
                this.remotePeerState.peerInterested = true;
                this.lastPeerActive = Date.now();
                this.emit("interested");
                break;

            case "UNINTERESTED":
                this.remotePeerState.peerInterested = false;
                this.lastPeerActive = Date.now();
                this.emit("uninterested");
                break;

            case "HAVE":
                if (msgObj.pieceIndex === undefined) {
                    return this.fail(
                        ErrorFactory.peer_state(
                            'INVALID_HAVE',
                            "HAVE message missing pieceIndex"
                        )
                    );
                }

                if (msgObj.pieceIndex > this.pieceCount - 1 || msgObj.pieceIndex < 0) {
                    return this.fail(
                        ErrorFactory.peer_state(
                            'INVALID_HAVE',
                            "HAVE message has invalid pieceIndex"
                        )
                    );
                }

                this.emit("have", msgObj.pieceIndex);
                this.updateRemoteBitfield(msgObj.pieceIndex);
                this.lastPeerActive = Date.now();
                break;

            case "BITFIELD":
                if (this.hasReceivedFirstMsg) {
                    return this.fail(
                        ErrorFactory.peer_state(
                            'INVALID_BITFIELD',
                            'Bitfield message must be the first message received after handshake'
                        )
                    );
                }
                if (msgObj.bitfield === undefined) {
                    return this.fail(
                        ErrorFactory.peer_state(
                            'INVALID_BITFIELD',
                            "Bitfield message missing even though id is bitfield"
                        )
                    );
                }

                if (!this.validateBitfield(msgObj.bitfield)) {
                    return this.fail(
                        ErrorFactory.peer_state(
                            'INVALID_BITFIELD',
                            "Invalid bitfield payload length or spare bits set",
                            { bitfield: msgObj.bitfield }
                        )
                    );
                }
                this.remotePeerState.bitfield = msgObj.bitfield;
                this.lastPeerActive = Date.now();
                this.emit("bitfield", msgObj.bitfield);
                break;

            case "PIECE": {
                if (msgObj.index === undefined || msgObj.begin === undefined || !msgObj.block) {
                    return this.fail(ErrorFactory.peer_state('INVALID_PIECE', 'Missing PIECE payload data'));
                }

                if (msgObj.index < 0 || msgObj.index >= this.pieceCount) {
                    return this.fail(ErrorFactory.peer_state('INVALID_PIECE', 'PIECE index out of bounds'));
                }

                const isLastPiece = msgObj.index === this.pieceCount - 1;
                const expectedPieceSize = isLastPiece
                    ? (this.totalLength % this.pieceLength) || this.pieceLength
                    : this.pieceLength;

                const blockLength = msgObj.block.length;

                if (blockLength === 0 || blockLength > 16384) {
                    return this.fail(ErrorFactory.peer_state('INVALID_PIECE', 'PIECE block size violates maximum 16 KiB limit'));
                }

                if (
                    msgObj.begin < 0 ||
                    msgObj.begin >= expectedPieceSize ||
                    (msgObj.begin + blockLength) > expectedPieceSize
                ) {
                    return this.fail(ErrorFactory.peer_state('INVALID_PIECE', 'PIECE offset or length exceeds piece boundary'));
                }

                const key = this.getRequestKey(msgObj.index, msgObj.begin);
                this.outstandingRequests.delete(key);

                this.emit("block", {
                    index: msgObj.index,
                    begin: msgObj.begin,
                    block: msgObj.block,
                });
                this.lastPeerActive = Date.now();
                break;
            }

            case "REQUEST": {
                if (msgObj.index === undefined || msgObj.begin === undefined || msgObj.length === undefined) {
                    return this.fail(ErrorFactory.peer_state('INVALID_REQUEST', 'Missing REQUEST payload data'));
                }

                if (msgObj.index < 0 || msgObj.index >= this.pieceCount) {
                    return this.fail(ErrorFactory.peer_state('INVALID_REQUEST', 'REQUEST index out of bounds'));
                }

                if (msgObj.length <= 0 || msgObj.length > 16384) {
                    return this.fail(ErrorFactory.peer_state(
                        'INVALID_REQUEST',
                        "REQUEST length violates standard 16KiB block size limit",
                        { length: msgObj.length }
                    ));
                }

                if (this.remotePeerState.amChoking) {
                    return this.fail(ErrorFactory.peer_state(
                        'INVALID_STATE_TRANSITION',
                        "Cannot accept REQUEST while we are choking the peer"
                    ));
                }

                const isLastPiece = msgObj.index === this.pieceCount - 1;
                const expectedPieceSize = isLastPiece
                    ? (this.totalLength % this.pieceLength) || this.pieceLength
                    : this.pieceLength;

                if (
                    msgObj.begin < 0 ||
                    msgObj.begin >= expectedPieceSize ||
                    (msgObj.begin + msgObj.length) > expectedPieceSize
                ) {
                    return this.fail(ErrorFactory.peer_state(
                        'INVALID_REQUEST',
                        "REQUEST offset or length exceeds piece boundaries",
                        { begin: msgObj.begin, length: msgObj.length, expectedPieceSize }
                    ));
                }

                this.emit("request", {
                    index: msgObj.index,
                    begin: msgObj.begin,
                    length: msgObj.length,
                });
                this.lastPeerActive = Date.now();
                break;
            }

            case "CANCEL": {
                if (msgObj.index === undefined || msgObj.begin === undefined || msgObj.length === undefined) {
                    return this.fail(ErrorFactory.peer_state('INVALID_CANCEL', 'Missing CANCEL payload data'));
                }

                if (msgObj.index < 0 || msgObj.index >= this.pieceCount) {
                    return this.fail(ErrorFactory.peer_state('INVALID_CANCEL', 'CANCEL index out of bounds'));
                }

                if (msgObj.length <= 0 || msgObj.length > 16384) {
                    return this.fail(ErrorFactory.peer_state(
                        'INVALID_CANCEL',
                        "CANCEL length violates standard 16KiB block size limit",
                        { length: msgObj.length }
                    ));
                }

                const isLastPiece = msgObj.index === this.pieceCount - 1;
                const expectedPieceSize = isLastPiece
                    ? (this.totalLength % this.pieceLength) || this.pieceLength
                    : this.pieceLength;

                if (
                    msgObj.begin < 0 ||
                    msgObj.begin >= expectedPieceSize ||
                    (msgObj.begin + msgObj.length) > expectedPieceSize
                ) {
                    return this.fail(ErrorFactory.peer_state(
                        'INVALID_CANCEL',
                        "CANCEL offset or length exceeds piece boundaries",
                        { begin: msgObj.begin, length: msgObj.length, expectedPieceSize }
                    ));
                }

                this.emit("cancel", {
                    index: msgObj.index,
                    begin: msgObj.begin,
                    length: msgObj.length,
                });
                this.lastPeerActive = Date.now();
                break;
            }
        }

        this.hasReceivedFirstMsg = true;
    }

    private dropOutstandingRequests(): void {
        for (const [, requestState] of this.outstandingRequests) {
            this.emit("request_dropped", requestState);
        }
        this.outstandingRequests.clear();
    }

    public inflightRequestCount(): number {
        return this.outstandingRequests.size;
    }

    private updateRemoteBitfield(pieceIdx: number): void {
        if (!this.remotePeerState.bitfield) {
            const expectedLength = Math.ceil(this.pieceCount / 8);
            this.remotePeerState.bitfield = Buffer.alloc(expectedLength);
        }

        const byteIdx = Math.floor(pieceIdx / 8);
        const bitOffset = 7 - (pieceIdx % 8);
        this.remotePeerState.bitfield[byteIdx] |= (1 << bitOffset);
    }

    private validateBitfield(payload: Buffer): boolean {
        const expectedLength = Math.ceil(this.pieceCount / 8);

        if (payload.length !== expectedLength) return false;

        const remainder = this.pieceCount % 8;
        if (remainder !== 0) {
            const unusedBits = 8 - remainder;
            const lastByte = payload[payload.length - 1];
            const mask = (1 << unusedBits) - 1;

            if ((lastByte & mask) !== 0) return false;
        }
        return true;
    }

    private sendPacket(id?: number, payload?: Buffer): void {
        if (this.lifecycleState !== 'READY' || !this.socket || this.socket.destroyed) {
            throw ErrorFactory.peer_state(
                'PEER_NOT_READY',
                `Cannot send packet: peer is in lifecycle state '${this.lifecycleState}' or socket is destroyed`
            );
        }

        if (id === undefined) {
            this.socket.write(Buffer.alloc(4));
            return;
        }

        const payloadLen = payload ? payload.length : 0;
        const msgBuf = Buffer.alloc(4 + 1 + payloadLen);

        msgBuf.writeUInt32BE(1 + payloadLen, 0);
        msgBuf.writeUInt8(id, 4);

        if (payload) payload.copy(msgBuf, 5);

        this.socket.write(msgBuf);
    }

    public choke(): void {
        if (this.remotePeerState.amChoking) return;
        this.remotePeerState.amChoking = true;
        this.sendPacket(0);
    }

    public unchoke(): void {
        if (!this.remotePeerState.amChoking) return;
        this.remotePeerState.amChoking = false;
        this.sendPacket(1);
    }

    public interested(): void {
        if (this.remotePeerState.amInterested) return;
        this.remotePeerState.amInterested = true;
        this.sendPacket(2);
    }

    public uninterested(): void {
        if (!this.remotePeerState.amInterested) return;
        this.remotePeerState.amInterested = false;
        this.sendPacket(3);
    }

    public have(index: number): void {
        if (index < 0 || index >= this.pieceCount) {
            throw ErrorFactory.peer_state(
                'INVALID_PIECE_INDEX',
                `Piece index ${index} is out of bounds`,
                { index, totalPieces: this.pieceCount }
            );
        }

        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(index, 0);

        this.sendPacket(4, payload);
    }

    public bitfield(bitfieldBuf: Buffer): void {
        if (!this.validateBitfield(bitfieldBuf)) {
            throw ErrorFactory.peer_state(
                'INVALID_BITFIELD',
                "Invalid bitfield payload length or spare bits set",
                { bitfield: bitfieldBuf }
            );
        }
        this.sendPacket(5, bitfieldBuf);
    }

    private getRequestKey(index: number, begin: number): string {
        return `${index}:${begin}`;
    }

    public request(index: number, begin: number, length: number): void {
        if (index < 0 || index >= this.pieceCount) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                "The given index is invalid"
            );
        }

        if (length <= 0 || length > 16384) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                "Requested length exceeds standard 16KiB block size",
                { length }
            );
        }

        if (this.remotePeerState.peerChoking) {
            throw ErrorFactory.peer_state(
                'INVALID_STATE_TRANSITION',
                "Cannot send REQUEST while peer is choking us"
            );
        }

        const isLastPiece = index === this.pieceCount - 1;
        const expectedPieceSize = isLastPiece
            ? (this.totalLength % this.pieceLength) || this.pieceLength
            : this.pieceLength;

        if (begin < 0 || begin >= expectedPieceSize || (begin + length) > expectedPieceSize) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                "Requested block exceeds piece length boundaries",
                { begin, length, expectedPieceSize }
            );
        }

        const key = this.getRequestKey(index, begin);
        if (this.outstandingRequests.has(key)) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                "Requested block is already inflight",
                { index, begin, length }
            );
        }

        const payload = this.constructPayload(index, begin, length);
        const requestState = { index, begin, length, requestedAt: Date.now() };

        this.outstandingRequests.set(key, requestState);

        try {
            this.sendPacket(6, payload);
        } catch (err) {
            this.outstandingRequests.delete(key);
            throw err;
        }
    }

    public piece(index: number, begin: number, block: Buffer): void {
        if (index < 0 || index >= this.pieceCount) {
            throw ErrorFactory.peer_state(
                'INVALID_PIECE',
                "The given index is invalid"
            );
        }

        const blockLength = block.length;
        if (blockLength <= 0 || blockLength > 16384) {
            throw ErrorFactory.peer_state(
                'INVALID_PIECE',
                "Given piece length exceeds standard 16KiB block size",
                { length: blockLength, block }
            );
        }

        const isLastPiece = index === this.pieceCount - 1;
        const expectedPieceSize = isLastPiece
            ? (this.totalLength % this.pieceLength) || this.pieceLength
            : this.pieceLength;

        if (
            begin < 0 ||
            begin >= expectedPieceSize ||
            (begin + blockLength) > expectedPieceSize
        ) {
            throw ErrorFactory.peer_state(
                'INVALID_PIECE',
                "Given block exceeds piece length boundaries",
                { begin, length: blockLength, pieceLength: this.pieceLength }
            );
        }

        const payload = Buffer.alloc(8 + blockLength);
        payload.writeUInt32BE(index, 0);
        payload.writeUInt32BE(begin, 4);
        payload.set(block, 8);
        this.sendPacket(7, payload);
    }

    public destroy(err?: Error): void {
        if (this.lifecycleState === 'CLOSED' || this.lifecycleState === 'FAILED') return;

        if (err) {
            this.fail(err);
            return;
        }

        this.lifecycleState = 'CLOSED';
        this.dropOutstandingRequests();
        this.cleanup();

        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy();
        }

        this.emit('SOCKET_CLOSED', {
            peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}`
        });
    }

    public cancel(index: number, begin: number, length: number): void {
        if (index < 0 || index >= this.pieceCount) {
            throw ErrorFactory.peer_state(
                'INVALID_CANCEL',
                "The given index is invalid"
            );
        }

        if (length <= 0 || length > 16384) {
            throw ErrorFactory.peer_state(
                'INVALID_CANCEL',
                "Given piece length for cancellation exceeds standard 16KiB block size",
                { length }
            );
        }

        const isLastPiece = index === this.pieceCount - 1;
        const expectedPieceSize = isLastPiece
            ? (this.totalLength % this.pieceLength) || this.pieceLength
            : this.pieceLength;

        if (begin < 0 || begin >= expectedPieceSize || (begin + length) > expectedPieceSize) {
            throw ErrorFactory.peer_state(
                'INVALID_CANCEL',
                "Given block exceeds piece length boundaries",
                { begin, length, expectedPieceSize }
            );
        }

        const key = this.getRequestKey(index, begin);
        this.outstandingRequests.delete(key);

        const payload = this.constructPayload(index, begin, length);
        this.sendPacket(8, payload);
    }

    private constructPayload(index: number, begin: number, length: number): Buffer {
        const payload = Buffer.alloc(12);
        payload.writeUInt32BE(index, 0);
        payload.writeUInt32BE(begin, 4);
        payload.writeUInt32BE(length, 8);
        return payload;
    }
}
