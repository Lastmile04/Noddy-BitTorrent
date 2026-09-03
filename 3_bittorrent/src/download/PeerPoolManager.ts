import EventEmitter from "node:events";
import * as net from 'net';
import { BitTorrentPeer } from "../transport/BitTorrentPeer.js";
import { BlockEventReceived, PeerBlockPayload, PeerPoolConfig, PeerRecord, PoolListeners } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";

export class PeerPoolManager extends EventEmitter {
    private peers: Map<string, BitTorrentPeer>;
    private poolListeners: Map<string, PoolListeners>;
    private readonly config: PeerPoolConfig;
    private readonly maxPeers: number;

    constructor(config: PeerPoolConfig) {
        super();
        this.config = config;
        this.maxPeers = config.maxPeers ?? 50;
        this.peers = new Map();
        this.poolListeners = new Map();
    }

    public connectToPeer(ip: string, port: number): void {
        const key = `${ip}:${port}`;

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

        peer.connect().catch((err) => {
            this.unregisterPeer(key, err);
        });
    }

    // QUERIES

    public getPeerRecords(): PeerRecord[] {
        const records: PeerRecord[] = [];

        for (const [key, peer] of this.peers.entries()) {
            if (peer.lifecycleState === 'FAILED' || peer.lifecycleState === 'CLOSED') continue;

            records.push({
                key,
                peerId: peer.remotePeerState.remotePeerId,
                lifecycleState: peer.lifecycleState,
                isChoked: peer.remotePeerState.peerChoking,
                amInterested: peer.remotePeerState.amInterested,
                peerInterested: peer.remotePeerState.peerInterested,
                inflightRequests: peer.inflightRequestCount(),
                downloadRate: peer.remotePeerState.downloadRate,
                hasPiece: (index: number) => this.checkPeerBitfield(peer, index),
            });
        }
        return records;
    }

    public getDownloadEligiblePeers(){}


    // COMMANDS

    /** Strict: Requires an active peer */
    public requestBlocks(key: string, index: number, begin: number, length: number): void {
        const peer = this.getOrThrow(key);

        if (peer.lifecycleState !== 'READY') {
            throw ErrorFactory.peer_state(
                'PEER_NOT_READY',
                `Lifecycle state is ${peer.lifecycleState}, expected READY`,
                { key }
            );
        }

        if (peer.remotePeerState.peerChoking) {
            throw ErrorFactory.peer_state(
                'INVALID_REQUEST',
                'Cannot request blocks while choked',
                { key }
            );
        }

        peer.request(index, begin, length);
    }

    /** Strict: Requires an active peer */
    public expressInterest(key: string): void {
        const peer = this.getOrThrow(key);
        if (peer.lifecycleState !== 'READY') {
            throw ErrorFactory.peer_state(
                'PEER_NOT_READY',
                `Lifecycle state is ${peer.lifecycleState}, expected READY`,
                { key }
            );
        }
        peer.interested();
    }

    /** Idempotent Cleanup: Safe no-op if peer dropped */
    public cancelRequest(key: string, index: number, begin: number, length: number): void {
        const peer = this.peers.get(key);
        if (!peer || peer.lifecycleState !== 'READY') return;
        peer.cancel(index, begin, length);
    }

    /** Idempotent Cleanup: Safe no-op if peer dropped */
    public revokeInterest(key: string): void {
        const peer = this.peers.get(key);
        if (!peer || peer.lifecycleState !== 'READY') return;
        peer.uninterested();
    }

    // LIFECYCLE & TEARDOWN

    public unregisterPeer(key: string, reason?: Error): void {
        const peer = this.peers.get(key);
        if (!peer) return;

        const wasReady = peer.lifecycleState === 'READY';

        // Detach ONLY pool listeners (prevents nuking BitTorrentPeer internal handlers)
        this.detachPeerListeners(key, peer);
        this.peers.delete(key);

        // Explicit socket connection termination
        peer.destroy();

        // Contextual lifecycle events for downstream consumers
        if (wasReady) {
            this.emit('peer_disconnected', { key, reason });
        } else {
            this.emit('peer_failed', { key, reason });
        }
    }

    public shutdown(): void {
        for (const key of Array.from(this.peers.keys())) {
            this.unregisterPeer(key, new Error('Pool shutting down'));
        }
        this.removeAllListeners();
    }

    // PRIVATE HELPERS

    private getOrThrow(key: string): BitTorrentPeer {
        const peer = this.peers.get(key);
        if (!peer) {
            throw ErrorFactory.peer_state(
                'PEER_UNAVAILABLE',
                `Peer ${key} is no longer active in the pool.`,
                { key }
            );
        }
        return peer;
    }

    private checkPeerBitfield(peer: BitTorrentPeer, index: number): boolean {
        const bitfield = peer.remotePeerState.bitfield;
        if (!bitfield) return false;

        const byteIdx = Math.floor(index / 8);
        const byte = bitfield[byteIdx];
        if (byte === undefined) return false;

        const bitOffset = 7 - (index % 8);
        return (byte & (1 << bitOffset)) !== 0;
    }

    private attachPeerListeners(key: string, peer: BitTorrentPeer): void {
        const onBlock = (data: PeerBlockPayload) => {
            const event: BlockEventReceived = {
                peerKey: key,
                index: data.index,
                begin: data.begin,
                block: data.block,
            };
            this.emit('block', event);
        };
        const onError = (err?: Error) => this.unregisterPeer(key, err);
        const onClosed = () => this.unregisterPeer(key);

        peer.on('block', onBlock);
        peer.on('error', onError);
        peer.on('SOCKET_CLOSED', onClosed);

        this.poolListeners.set(key, { block: onBlock, error: onError, closed: onClosed });
    }

    private detachPeerListeners(key: string, peer: BitTorrentPeer): void {
        const bound = this.poolListeners.get(key);
        if (!bound) return;

        peer.off('block', bound.block);
        peer.off('error', bound.error);
        peer.off('SOCKET_CLOSED', bound.closed);

        this.poolListeners.delete(key);
    }
}
