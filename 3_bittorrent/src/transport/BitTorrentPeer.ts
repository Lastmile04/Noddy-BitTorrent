import EventEmitter from "node:events";
import * as net from 'net';
import { HandshakeResult, PeerConfig, PeerState, BT_PROTOCOL_LEN, BT_PROTOCOL_BUFFER, BT_PROTOCOL_STR, PeerMessage } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";
import { trace } from "node:console";
import { truncate } from "node:fs";
import { SocketErrorCode } from "../errors/types.js";

export class BitTorrentPeer extends EventEmitter {

    remotePeerState: PeerState;
    socket: net.Socket;
    peerId: Buffer;
    infoHash: Buffer;
    pieceLength: number;
    totalLength: number;
    handshakeComplete: boolean;
    DEFAULT_CONNECT_TIMEOUT: number;
    connectTimeout?: NodeJS.Timeout;
    bufQueue: Buffer[]
    bufferedBytes: number
    lastPeerActive?: number
    handledFailure: boolean

    constructor({ socket, peer, peerId, infoHash, pieceLength, totalLength }: PeerConfig) {
        super();
        this.socket = socket;
        this.peerId = peerId;
        this.infoHash = infoHash;
        this.pieceLength = pieceLength;
        this.totalLength = totalLength;
        this.handshakeComplete = false;
        this.DEFAULT_CONNECT_TIMEOUT = 10000;
        this.connectTimeout = undefined;
        this.bufQueue = [];
        this.bufferedBytes = 0;
        this.lastPeerActive = undefined;
        this.handledFailure = false;

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

                    if (this.connectTimeout) clearTimeout(this.connectTimeout);
                    this.emit("HANDSHAKE_SUCCESS", parsed);

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

    // --- Helper functions And State Update Methods ---

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
        }

        const receivedPstr = buf.subarray(1, 1 + receivedPstrLen);
        if (!receivedPstr.equals(BT_PROTOCOL_BUFFER)) {
            this.fail(
                ErrorFactory.network(
                    'PROTOCOL_VIOLATION',
                    'Protocol string mismatch',
                    {
                        originalBuf: BT_PROTOCOL_BUFFER,
                        receivedBuf: receivedPstr
                    }
                ),
            )
        }

        const reservedOffset = 1 + receivedPstrLen;
        const reserved = buf.subarray(reservedOffset, reservedOffset + 8);

        const infoHashOffset = reservedOffset + 8;
        const receivedInfoHash = buf.subarray(infoHashOffset, infoHashOffset + 20);

        if (!receivedInfoHash.equals(this.infoHash)) {
            this.fail(
                ErrorFactory.network(
                    'PROTOCOL_VIOLATION',
                    'InfoHash mismatch',
                    {
                        originalInfoHash: this.infoHash,
                        receivedInfoHash: receivedInfoHash
                    },
                )
            )
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


    private onEnd(): void {
        // Handle stream end
        if (!this.handshakeComplete && !this.handledFailure) {
            this.emit('End event emitted even though hanshake is incomplete');
            return
        };

        this.emit('CONNECTION_CLOSED');
    }

    private onClose(): void {
        // Handle socket disconnect
        if (!this.handshakeComplete && !this.handledFailure) {
            this.handledFailure = true;
            this.fail(
                ErrorFactory.socket(
                    'HANDSHAKE_INCOMPLETE',
                    'Socket closed even though hanshake is incomplete'
                )
            )
            return
        };

        this.emit("SOCKET_CLOSED", {
            peer: `${this.remotePeerState.ip}:${this.remotePeerState.port}`
        });
    }

    private onError(err: Error): void {
        // Extract native Node.js socket error code (e.g. ECONNREFUSED)
        const sysErr = err as NodeJS.ErrnoException;
        const mappedCode = this.mapSocketErrorCode(sysErr.code);

        this.fail(
            ErrorFactory.socket(
                mappedCode,
                sysErr.message || 'Underlying transport socket error'
            )
        );
    }

    /**
     * Maps raw OS/Node.js socket error codes to application-level codes
     */
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


    private onConnect(): void {
        // Handle successful connection
    }

    private fail(err: Error): void {
        if (this.handledFailure) return;
        this.handledFailure = true;

        // 1. Clear any active connection timers
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }

        // 2. Detach socket listeners to prevent memory leaks
        this.detachTransportHandlers();

        // 3. Destroy socket if open
        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy();
        }

        // 4. Emit standard error for factory/pool manager
        this.emit("error", err);
    }
}
