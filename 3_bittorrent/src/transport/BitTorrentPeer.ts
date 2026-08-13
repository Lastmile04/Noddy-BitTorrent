import EventEmitter from "node:events";
import * as net from 'net';
import { PeerConfig, PeerState } from "./types.js";
import { BT_PROTOCOL_LEN, BT_PROTOCOL_BUFFER, BT_PROTOCOL_STR } from "./types.js";

export class BitTorrentPeer extends EventEmitter {

    peerSession: PeerState;
    socket: net.Socket;
    peerId: Buffer;
    infoHash: Buffer;
    pieceLength: number;
    totalLength: number;
    handShakeComplete: boolean;
    DEFAULT_CONNECT_TIMEOUT: number;
    connectTimeout?: NodeJS.Timeout;
    bufQueue: Buffer[]
    bufferedBytes: number

    constructor({ socket, peer, peerId, infoHash, pieceLength, totalLength }: PeerConfig) {
        super();
        this.socket = socket;
        this.peerId = peerId;
        this.infoHash = infoHash;
        this.pieceLength = pieceLength;
        this.totalLength = totalLength;
        this.handShakeComplete = false;
        this.DEFAULT_CONNECT_TIMEOUT = 10000;
        this.connectTimeout = undefined;
        this.bufQueue = [];
        this.bufferedBytes = 0;

        this.peerSession = {
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
            if (!this.handShakeComplete) {
                if (this.bufferedBytes < 1) break;

                const receivedPstrLen = this.bufQueue[0][0];
                if (receivedPstrLen !== BT_PROTOCOL_LEN) {
                    this.fail(new Error("Invalid protocol length"));
                    return;
                }

                const handshakeLen = receivedPstrLen + 49;
                if (this.bufferedBytes < handshakeLen) break;

                try {
                    const fullBuf = this.consumeBytes(handshakeLen);

                    const parsed = this.parseHandshake(fullBuf);
                    this.handShakeComplete = true;

                    if (this.connectTimeout) clearTimeout(this.connectTimeout);
                    this.emit("HANDSHAKE_SUCCESS", parsed);

                } catch (err) {
                    this.fail(err);
                    return;
                }
            } else {

            }
        }
    }

    private onEnd(): void {
        // Handle stream end
    }

    private onClose(): void {
        // Handle socket disconnect
    }

    private onError(err: Error): void {
        // Handle socket errors
    }

    private onConnect(): void {
        // Handle successful connection
    }

    private fail(err) {
        this.emit("ERROR", {
            peer: `${this.peerSession.ip}:${this.peerSession.port}`,
            type: err.type || "UNKNOWN",
            message: err.message || "Unknown error"
        });
        this.cleanup();
        this.socket.destroy();
        this.reject(err);
    }
}
