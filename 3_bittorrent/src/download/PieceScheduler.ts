import { EventEmitter } from "node:events";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { PieceSelector } from "./PieceSelector.js";
import {
    PieceSchedulerConfig,
    BlockRequest,
    WorkingPieceState,
    InflightBlockRequest,
    ReceivedBlock
} from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";

export enum SchedulerMode {
    BEGIN = "BEGIN",
    NORMAL = "NORMAL",
    ENDGAME = "ENDGAME"
}

export class PieceScheduler extends EventEmitter {
    public readonly pieceLength: number;
    public readonly pieceCount: number;
    public readonly lastPieceLength: number;

    public readonly pieceManager: PieceManager;
    public readonly peerPoolManager: PeerPoolManager;
    public readonly pieceSelector: PieceSelector;

    private requestQueue: BlockRequest[];
    private inflightMap: Map<string, InflightBlockRequest>;
    private workingPieceMap: Map<number, WorkingPieceState>;

    private mode: SchedulerMode = SchedulerMode.BEGIN;

    // Operational Tunables
    private readonly MAX_REQUEST_PER_PEER: number = 8;
    private readonly BLOCK_SIZE: number = 16384;
    private readonly CURRENT_WORKING_LIMIT: number = 8;
    private readonly BLOCK_TIMEOUT_MS: number = 15000;

    constructor({
        pieceManager,
        peerPoolManager,
        pieceLength,
        pieceCount,
        lastPieceLength
    }: PieceSchedulerConfig) {
        super();
        this.pieceCount = pieceCount;
        this.pieceLength = pieceLength;
        this.lastPieceLength = lastPieceLength;

        this.pieceManager = pieceManager;
        this.peerPoolManager = peerPoolManager;
        this.pieceSelector = new PieceSelector(pieceCount);

        this.requestQueue = [];
        this.inflightMap = new Map();
        this.workingPieceMap = new Map();
    }

    public start(): void {
        this.attachListeners();
        this.schedule();
    }

    public getMode(): SchedulerMode {
        return this.mode;
    }

    private schedule(): void {
        // Evict expired requests so they are immediately discoverable in step 5
        this.sweepStaleInflightRequests();

        // Query globally unverified/missing pieces
        const needed = this.pieceManager.findNeeded();
        if (needed.length === 0) {
            this.emit('complete');
            return;
        }

        // Replenish working set capacity
        const selectionCapacity = this.CURRENT_WORKING_LIMIT - this.workingPieceMap.size;
        if (selectionCapacity > 0) {
            const selectedPieces = this.selectPiecesForWorkingSet(needed, selectionCapacity);
            this.addWorkingPiece(selectedPieces);
        }

        // Resolve eligible peers for active working set
        const eligiblePeers = this.getEligiblePeers();

        // Gather missing block offsets & dispatch onto peer pipelines
        this.queueRequests();
        this.dispatchQueuedRequests(eligiblePeers);
    }

    private selectPiecesForWorkingSet(needed: number[], limit: number): number[] {
        // Exclude pieces with zero available seeders/peers
        const candidates = needed.filter(
            (index) => index >= 0 && index < this.pieceCount && this.pieceSelector.availabilityArray[index] > 0
        );

        if (candidates.length === 0) return [];

        if (this.mode === SchedulerMode.BEGIN) {
            // Fisher-Yates shuffle over candidates with known sources
            const shuffled = [...candidates];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            // Single-pass bootstrap: unconditionally transition to NORMAL for all subsequent refills
            this.mode = SchedulerMode.NORMAL;

            return shuffled.slice(0, limit);
        }

        // NORMAL mode: Delegate to deterministic Rarest-First policy
        return this.pieceSelector.select(candidates, limit);
    }

    private addWorkingPiece(pieceIdxArray: number[]): void {
        for (const pieceIdx of pieceIdxArray) {
            if (this.workingPieceMap.has(pieceIdx)) continue;
            this.workingPieceMap.set(pieceIdx, {
                addedAt: Date.now(),
                lastProgressAt: Date.now()
            });
        }
    }

    private getEligiblePeers(): Map<number, Set<string>> {
        const pieces = Array.from(this.workingPieceMap.keys());
        const pieceToPeers = this.pieceSelector.getSources(pieces);

        for (const [pieceIdx, peerKeySet] of pieceToPeers.entries()) {
            const validKeys = this.peerPoolManager.filterEligiblePeers(peerKeySet, this.MAX_REQUEST_PER_PEER);
            pieceToPeers.set(pieceIdx, validKeys);
        }

        return pieceToPeers;
    }

    private queueRequests(): void {
        for (const pieceIdx of this.workingPieceMap.keys()) {
            const missingOffsets = this.pieceManager.getMissingOffsets(pieceIdx);

            for (const begin of missingOffsets) {
                const currentPieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;
                const length = Math.min(this.BLOCK_SIZE, currentPieceSize - begin);

                const inflightKey = `${pieceIdx}-${begin}`;
                if (this.inflightMap.has(inflightKey)) continue;

                const isAlreadyQueued = this.requestQueue.some(req => req.index === pieceIdx && req.begin === begin);
                if (isAlreadyQueued) continue;

                this.requestQueue.push({ index: pieceIdx, begin, length });
            }
        }
    }

    private dispatchQueuedRequests(peersMap: Map<number, Set<string>>): void {
        const deferredRequests: BlockRequest[] = [];

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift()!;
            const inflightKey = `${request.index}-${request.begin}`;

            if (this.inflightMap.has(inflightKey)) continue;

            const validPeerKeys = peersMap.get(request.index);
            let assignedPeerKey: string | null = null;

            if (validPeerKeys) {
                for (const peerKey of validPeerKeys) {
                    const activePipelineSize = this.peerPoolManager.getInflightRequestCount(peerKey);
                    if (activePipelineSize < this.MAX_REQUEST_PER_PEER) {
                        assignedPeerKey = peerKey;
                        break;
                    }
                }
            }

            if (assignedPeerKey) {
                const inflightReq: InflightBlockRequest = {
                    ...request,
                    peerKey: assignedPeerKey,
                    sentAt: Date.now()
                };

                this.inflightMap.set(inflightKey, inflightReq);
                this.peerPoolManager.requestBlocks(assignedPeerKey, request.index, request.begin, request.length);
            } else {
                deferredRequests.push(request);
            }
        }

        this.requestQueue = deferredRequests;
    }

    private sweepStaleInflightRequests(): void {
        const now = Date.now();
        for (const [key, req] of this.inflightMap.entries()) {
            if (req.sentAt && (now - req.sentAt > this.BLOCK_TIMEOUT_MS)) {
                this.inflightMap.delete(key);
            }
        }
    }

    private evictInflightForPiece(pieceIdx: number): void {
        for (const [key, block] of this.inflightMap.entries()) {
            if (block.index === pieceIdx) {
                this.inflightMap.delete(key);
            }
        }
    }

    private evictInflightForPeer(peerKey: string): void {
        for (const [inflightKey, block] of this.inflightMap.entries()) {
            if (block.peerKey === peerKey) {
                this.inflightMap.delete(inflightKey);
            }
        }
    }

    private attachListeners(): void {
        // Peer pool events
        this.peerPoolManager.on('block', (data) => this.handleBlockReceived(data));
        this.peerPoolManager.on('peer_ready', () => this.schedule());
        this.peerPoolManager.on('peer_unchoked', () => this.schedule());

        // Update selector state AND wake up scheduler loop on availability changes
        this.peerPoolManager.on('peer_have', (data) => {
            this.pieceSelector.updatePieceToPeersMap(data.key, data.index);
            this.schedule();
        });

        this.peerPoolManager.on('peer_bitfield', (data) => {
            this.pieceSelector.updatePieceToPeersMap(data.key, data.bitfield);
            this.schedule();
        });

        this.peerPoolManager.on('peer_choked', ({ key }) => {
            this.evictInflightForPeer(key);
            this.schedule();
        });

        const handlePeerRemoval = ({ key }: { key: string }) => {
            this.pieceSelector.removePeer(key);
            this.evictInflightForPeer(key);
            this.schedule();
        };

        this.peerPoolManager.on('peer_disconnected', handlePeerRemoval);
        this.peerPoolManager.on('peer_failed', handlePeerRemoval);

        // PieceManager events
        this.pieceManager.on('piece_verified', (pieceIdx) => this.handlePieceVerification(pieceIdx));

        this.pieceManager.on('piece_verification_failed', (pieceIdx) => {
            // Retain piece inside workingPieceMap. Evict stale inflight records.
            this.evictInflightForPiece(pieceIdx);
            this.schedule(); // Rediscover all missing block offsets automatically via getMissingOffsets()
        });

        this.pieceManager.on('download_complete', () => {
            this.emit('download_complete');
        });
    }

    private handlePieceVerification(pieceIdx: number): void {
        this.workingPieceMap.delete(pieceIdx);
        this.evictInflightForPiece(pieceIdx);
        this.schedule();
    }

    private handleBlockReceived(data: ReceivedBlock): void {
        const inflightKey = `${data.index}-${data.begin}`;
        const inflightBlock = this.inflightMap.get(inflightKey);

        if (!inflightBlock) return;
        if (inflightBlock.peerKey !== data.peerKey) return;

        if (inflightBlock.length !== data.block.length) {
            this.inflightMap.delete(inflightKey);
            this.emit('error', ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                `Block of invalid length sent by peer: ${inflightBlock.peerKey}`
            ));
            this.schedule();
            return;
        }

        try {
            this.pieceManager.acceptBlock(data.index, data.begin, data.block);
        } catch (err) {
            this.inflightMap.delete(inflightKey);
            this.emit('error', err);
            this.schedule();
            return;
        }

        this.inflightMap.delete(inflightKey);
        const pieceState = this.workingPieceMap.get(data.index);

        if (pieceState) {
            pieceState.lastProgressAt = Date.now();
        }

        this.schedule();
    }
}
