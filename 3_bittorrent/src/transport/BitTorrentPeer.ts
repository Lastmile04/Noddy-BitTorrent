import EventEmitter from "node:events";
import * as net from 'net';
import { HandshakeResult, PeerConfig, PeerState, BT_PROTOCOL_LEN, BT_PROTOCOL_BUFFER, PeerMessage } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";
import { LifecycleStateOpts, SocketErrorCode } from "../errors/types.js";

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
    resolve: any;
    reject: any;

    constructor({ socket, peer, peerId, infoHash, pieceLength, totalLength }: PeerConfig) {
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
        this.resolve = undefined;
        this.reject = undefined;

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

    public connect() {
        if (this.lifecycleState === 'NEW') {
            return new Promise((res, rej) => {
                this.resolve = res;
                this.reject = rej;
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
        }
        else {
            throw ErrorFactory.peer_state(
                'INVALID_STATE_TRANSITION',
                "The caller asked this peer to perform an operation that isn't valid in its current state"
            );
        }
    }


    private onConnect(): void {
        // Handle successful connection
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
            this.fail(this.identifyError(err as Error));
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
                        ),
                    )
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

                    if (this.resolve) {
                        this.resolve();

                        this.resolve = undefined;
                        this.reject = undefined;
                    }

                } catch (err) {
                    this.fail(ErrorFactory.normalize(err));
                }
            } else {
                if (this.bufferedBytes < 4) break;

                const messageLength = this.peekUInt32BE(); // to get the length num from message prefix
                const totalMsgLen = 4 + messageLength;

                if (this.bufferedBytes < totalMsgLen) break;

                let msgBuf = this.consumeBytes(totalMsgLen).subarray(4);

                const msgObj = this.parseMsg(msgBuf);
                this.handlePeerMessage(msgObj);
            }
        }
    }


    private onEnd(): void {
        // Handle stream end
        if (!this.handshakeComplete && !this.handledFailure) {
            this.emit('End event emitted even though handshake is incomplete');
            return
        };

        this.emit('CONNECTION_CLOSED');
    }


    private onClose(): void {
        // Handle socket disconnect
        if (!this.handshakeComplete && !this.handledFailure) {
            this.fail(
                ErrorFactory.socket(
                    'HANDSHAKE_INCOMPLETE',
                    'Socket closed even though handshake is incomplete'
                )
            )
            return
        };

        this.lifecycleState = 'CLOSED';
        this.emit("SOCKET_CLOSED", {
            peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}`
        });
    }


    private onError(err: Error): void {
        this.fail(this.identifyError(err));
    }




    private fail(err: Error): void {
        if (this.handledFailure) return;
        this.handledFailure = true;

        this.lifecycleState = 'FAILED';

        this.cleanup();
        if (this.socket && !this.socket.destroyed) this.socket.destroy();
        if (this.handshakeComplete && this.reject) this.reject(err);

        this.reject = undefined;
        this.resolve = undefined;

        this.emit("error", err);
    }


    // --- Helper functions And State Update Methods ---

    private cleanup() {
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
        // If the 4-byte length prefix spans across multiple chunks, combine just enough bytes
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
                return { type: "UNKNOWN", id };
        }
    }


    private handlePeerMessage(msgObj: PeerMessage): void {

        switch (msgObj.type) {
            case "KEEP_ALIVE":
                this.lastPeerActive = Date.now();
                break;

            case "CHOKE":
                this.remotePeerState.peerChoking = true;
                this.lastPeerActive = Date.now();
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
                this.emit("have", msgObj.pieceIndex);
                this.lastPeerActive = Date.now();
                break;

            case "BITFIELD":
                this.remotePeerState.bitfield = msgObj.bitfield;
                this.lastPeerActive = Date.now();
                this.emit("bitfield", msgObj.bitfield);
                break;

            case "PIECE":
                this.emit("block", {
                    index: msgObj.index,
                    begin: msgObj.begin,
                    block: msgObj.block,
                });
                this.lastPeerActive = Date.now();
                break;

            case "REQUEST":
                this.emit("request", {
                    index: msgObj.index,
                    begin: msgObj.begin,
                    length: msgObj.length,
                });
                this.lastPeerActive = Date.now();
                break;

            case "CANCEL":
                this.emit("cancel", {
                    index: msgObj.index,
                    begin: msgObj.begin,
                    length: msgObj.length,
                });
                this.lastPeerActive = Date.now();
                break;
        }
    }

    private sendPacket(id?: number, payload?: Buffer): void {
        if (!this.socket || this.socket.destroyed) return;

        if (id === undefined) {
            this.socket.write(Buffer.alloc(4));
            return;
        }

        const payloadLen = payload ? payload.length : 0;
        const msgBuf = Buffer.alloc(4 + 1 + payloadLen);

        msgBuf.writeUInt32BE(1 + payloadLen, 0); // write length
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

    public have(): void {
    }

    public bitfield(): void { }

    public request(index: number, begin: number, length: number): void {
        if (length > 16384) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                "Requested length exceeds standard 16KiB block size",
                { length: length }
            );
        }

        if (this.remotePeerState.peerChoking) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                'Cannot send REQUEST while peer is choking us',
                { peerChokingStatus: this.remotePeerState.peerChoking }
            );
        }

        const payload = Buffer.alloc(12);
        payload.writeUInt32BE(index, 0);
        payload.writeUInt32BE(begin, 4);
        payload.writeUInt32BE(length, 8);

        this.sendPacket(6, payload);
    }

    public piece():void {}

    public cancel():void {}



    // Normalizes system/socket errors vs generic application errors
    private identifyError(err: Error): Error {
        const sysErr = err as NodeJS.ErrnoException;

        // Check if the error originates from the OS/Socket layer (has an error code)
        if (sysErr.code) {
            const mappedCode = this.mapSocketErrorCode(sysErr.code);
            return ErrorFactory.socket(
                mappedCode,
                sysErr.message || 'Underlying transport socket error'
            );
        }

        // Generic/Runtime error fallback
        return ErrorFactory.normalize(err);
    }


    private mapSocketErrorCode(code?: string): SocketErrorCode {
        switch (code) {
            case 'ECONNREFUSED':
                return 'CONNECTION_REFUSED';
            case 'ETIMEDOUT':
                return 'CONNECTION_TIMED_OUT';
            case 'ECONNRESET':
                return 'CONNECTION_RESET';
            case 'EPIPE':
                return 'BROKEN_PIPE';
            default:
                return 'SOCKET_ERROR';
        }
    }

}
