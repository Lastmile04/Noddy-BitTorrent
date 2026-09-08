import EventEmitter from "node:events";
import * as net from 'net';
import { BitTorrentPeer } from "../transport/BitTorrentPeer.js";
import { PeerBlockPayload, PeerPoolConfig, PeerRecord, PoolListeners } from "./types.js";
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

        peer.connect().catch(() => {
            // Connection failures invoke peer.fail() internally, emitting an 'error' event.
            // Pool handles cleanup via its 'error' listener. Catching here prevents unhandled rejections.
        });
    }

    // --- QUERIES ---

    /** Returns all currently READY (usable) peers eligible for block scheduling. */
    public getPeerRecords(): PeerRecord[] {
        const records: PeerRecord[] = [];

        for (const [key, peer] of this.peers.entries()) {
            if (peer.lifecycleState !== 'READY') continue;

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

    // --- COMMANDS ---

    /** Strict: Requires an active READY peer. Propagates invariant & transport errors to caller. */
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
                'INVALID_STATE_TRANSITION',
                'Cannot request blocks while choked',
                { key }
            );
        }

        peer.request(index, begin, length);
    }

    /** Expresses interest to peer if READY */
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

    /** Propagates invariant violations (e.g. INVALID_CANCEL) to caller */
    public cancelRequest(key: string, index: number, begin: number, length: number): void {
        const peer = this.peers.get(key);
        if (!peer || peer.lifecycleState !== 'READY') return;
        peer.cancel(index, begin, length);
    }

    /** Revokes interest from peer if READY */
    public revokeInterest(key: string): void {
        const peer = this.peers.get(key);
        if (!peer || peer.lifecycleState !== 'READY') return;
        peer.uninterested();
    }

    // --- LIFECYCLE & TEARDOWN ---

    /** 
     * Removes peer from membership. 
     * `destroyPeer` is true only for administrative eviction/shutdown, as terminal peer errors 
     * are already handled by BitTorrentPeer internally.
     */
    public unregisterPeer(key: string, reason?: Error, options: { destroyPeer?: boolean } = {}): void {
        const peer = this.peers.get(key);
        if (!peer) return;

        const wasReady = peer.lifecycleState === 'READY';

        this.detachPeerListeners(key, peer);
        this.peers.delete(key);

        if (options.destroyPeer) {
            peer.destroy(reason);
        }

        if (wasReady) {
            this.emit('peer_disconnected', { key, reason });
        } else {
            this.emit('peer_failed', { key, reason });
        }
    }

    public shutdown(): void {
        for (const key of Array.from(this.peers.keys())) {
            this.unregisterPeer(key, new Error('Pool shutting down'), { destroyPeer: true });
        }
        this.removeAllListeners();
    }

    // --- PRIVATE HELPERS ---

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
        const listeners: PoolListeners = {
            block: (data: PeerBlockPayload) => {
                this.emit('block', { peerKey: key, index: data.index, begin: data.begin, block: data.block });
            },
            error: (err?: Error) => this.unregisterPeer(key, err),
            closed: () => this.unregisterPeer(key),
            ready: () => this.emit('peer_ready', { key }),
            choke: () => this.emit('peer_choked', { key }),
            unchoke: () => this.emit('peer_unchoked', { key }),
            have: (index: number) => this.emit('peer_have', { key, index }),
            bitfield: () => {
                if (peer.remotePeerState.bitfield) {
                    this.emit('peer_bitfield', { key, bitfield: peer.remotePeerState.bitfield });
                }
            },
        };

        peer.on('block', listeners.block);
        peer.on('error', listeners.error);
        peer.on('SOCKET_CLOSED', listeners.closed);
        peer.on('HANDSHAKE_SUCCESS', listeners.ready);
        peer.on('choke', listeners.choke);
        peer.on('unchoke', listeners.unchoke);
        peer.on('have', listeners.have);
        peer.on('bitfield', listeners.bitfield);

        this.poolListeners.set(key, listeners);
    }

    private detachPeerListeners(key: string, peer: BitTorrentPeer): void {
        const bound = this.poolListeners.get(key);
        if (!bound) return;

        peer.off('block', bound.block);
        peer.off('error', bound.error);
        peer.off('SOCKET_CLOSED', bound.closed);
        peer.off('HANDSHAKE_SUCCESS', bound.ready);
        peer.off('choke', bound.choke);
        peer.off('unchoke', bound.unchoke);
        peer.off('have', bound.have);
        peer.off('bitfield', bound.bitfield);

        this.poolListeners.delete(key);
    }
}
