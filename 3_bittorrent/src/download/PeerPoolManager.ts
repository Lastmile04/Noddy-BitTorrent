import EventEmitter from "node:events";
import { BitTorrentPeer } from "../transport/BitTorrentPeer.js";
import { PeerPoolConfig, PeerRecord } from "./types.js";
import * as net from 'net';

export class PeerPoolManager extends EventEmitter {
    private peers: Map<string, BitTorrentPeer>;
    private readonly config: PeerPoolConfig;
    private readonly maxPeers: number;

    constructor(config: PeerPoolConfig) {
        super();
        this.config = config;
        this.maxPeers = config.maxPeers ?? 50;
        this.peers = new Map();
    }

    connectToPeer(ip: string, port: number): void {
        const key = `${ip}:${port}`;

        // Prevent duplicate connection and respect the pool population cap
        if (this.peers.has(key) || this.peers.size >= this.maxPeers) return;

        const peer = new BitTorrentPeer({
            socket: new net.Socket(),
            peer: { ip, port },
            peerId: this.config.peerId,
            infoHash: this.config.infoHash,
            pieceLength: this.config.pieceLength,
            totalLength: this.config.totalLength,
            pieceCount: this.config.pieceCount,
        });
        this.peers.set(key, peer);
        this.attachPeerListeners(key, peer);

        peer.connect().catch(() => { });
    }

    public getEligiblePeers(): PeerRecord[] {
        const record: PeerRecord[] = [];

        for (const [key, peer] of this.peers.entries()) {
            if (peer.lifecycleState !== 'READY' || peer.remotePeerState.peerChoking) continue;

            record.push({
                key,
                peerId: peer.remotePeerState.remotePeerId,
                isEligible: true,
                isChoked: peer.remotePeerState.peerChoking,
                inflightRequests: peer.inflightRequestCount(),
                downloadRate: peer.remotePeerState.downloadRate,
                hasPiece: (index: number) => this.checkPeerBitfield(peer, index),
            });
        }
        return record;
    }

    private checkPeerBitfield(peer: BitTorrentPeer, index: number): boolean {
        const bitfield = peer.remotePeerState.bitfield;
        if (!bitfield) return false;

        const byteIdx = Math.floor(index / 8);
        const byte = bitfield[byteIdx];

        // Handles out-of-bounds & satisfies strict TypeScript undefined checks
        if (byte === undefined) return false;

        const bitOffset = 7 - (index % 8);
        return (byte & (1 << bitOffset)) !== 0;
    }

    private attachPeerListeners(key: string, peer: BitTorrentPeer): void {
        peer.on('block', (data) => this.emit('block', data));

        const cleanup = () => {
            if (this.peers.has(key)) {
                this.peers.delete(key);
                this.emit('peer_disconnected', key);
            }
        };

        peer.on('error', cleanup);
        peer.on('SOCKET_CLOSED', cleanup);
    }
}
