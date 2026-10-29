import * as net from "node:net";
import { EventEmitter } from "node:events";
import { PeerPoolManager } from "../download/PeerPoolManager.js";
import { PeerServerConfig } from "./types.js";

export class PeerServer extends EventEmitter {
    private server: net.Server;
    private port: number;
    private peerPoolManager: PeerPoolManager;

    constructor({
        port,
        peerPoolManager
    }: PeerServerConfig) {
        super();
        this.port = port;
        this.peerPoolManager = peerPoolManager;

        this.server = net.createServer(this.handleIncomingSockets.bind(this));
    }

    public start(): void {
        this.server.listen(this.port, '0.0.0.0', () => {
            // console.log(`🚀 Inbound BitTorrent server listening on port ${this.port}`);
        });
    }

    public stop(): void {
        this.server.close();
    }

    private handleIncomingSockets(socket: net.Socket): void {
        const remoteIP = socket.remoteAddress || 'unknown';
        const remotePort = socket.remotePort || 0;

        // console.log(`📥 Incoming connection from peer: ${remoteIP}:${remotePort}`);

        // Delegate socket registration directly to PeerPoolManager
        this.peerPoolManager.registerInboundPeer(socket, remoteIP, remotePort);
    }
}
