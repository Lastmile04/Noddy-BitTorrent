import EventEmitter from "node:events";
import { BlockRequest, DownloadMode, PeerRecord, PieceSchedulerConfig, PieceStrategy } from "./types.js";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { ErrorFactory } from "../errors/TorrentError.js";

const BLOCK_SIZE = 16384;

export class PieceScheduler extends EventEmitter {
    pieceLength: number;
    pieceCount: number;
    lastPieceLength: number;
    pieceManager: PieceManager;
    peerPoolManager: PeerPoolManager;
    queuedRequests: BlockRequest[];

    private inflightRequestMap: Map<string, BlockRequest[]>;
    private peersByPiece: Map<number, Set<string>>;

    /**
     * piecesByAvailability represents availability strictly among the peers 
     * currently known and connected to this client, not absolute swarm-wide rarity.
     */
    private piecesByAvailability: Map<number, Set<number>>;

    private isRunning: boolean;
    private mode: DownloadMode;
    private strategy: PieceStrategy;
    private activePieceIdx: Set<number>;
    private hasCompletedInitialPiece: boolean;

    private readonly MAX_INFLIGHT_PER_PEER = 5;
    private readonly MAX_WORKING_SET_PIECES = 8;

    // Reentrancy guards
    private isScheduling: boolean = false;
    private scheduleRequested: boolean = false;

    constructor({
        pieceLength,
        pieceCount,
        lastPieceLength,
        pieceManager,
        peerPoolManager
    }: PieceSchedulerConfig) {
        super();
        this.pieceLength = pieceLength;
        this.pieceCount = pieceCount;
        this.lastPieceLength = lastPieceLength;
        this.pieceManager = pieceManager;
        this.peerPoolManager = peerPoolManager;
        this.queuedRequests = [];
        this.inflightRequestMap = new Map();
        this.isRunning = false;
        this.mode = 'ACTIVE';
        this.strategy = 'RANDOM_FIRST';
        this.activePieceIdx = new Set();
        this.hasCompletedInitialPiece = false;
        this.peersByPiece = new Map();
        this.piecesByAvailability = new Map();
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.attachListeners();
        // JavaScript's synchronous execution guarantees this snapshotting process 
        // won't be interleaved with incoming peer network events.
        this.initializeAvailabilityTracking();
        this.schedule();
    }

    /**
     * Event-driven schedule entry point. 
     * Protected against synchronous reentrancy (e.g., if dispatching a block triggers 
     * an immediate synchronous event that calls schedule() again).
     */
    private schedule(): void {
        if (!this.isRunning) return;

        if (this.isScheduling) {
            this.scheduleRequested = true;
            return;
        }

        this.isScheduling = true;
        this.scheduleRequested = false;

        try {
            this.performSchedulingPass();
        } finally {
            this.isScheduling = false;
            if (this.scheduleRequested) {
                // Defer subsequent scheduling to prevent call-stack overflow 
                // while ensuring no state changes are ignored.
                queueMicrotask(() => this.schedule());
            }
        }
    }

    private performSchedulingPass(): void {
        // Snapshot 1: Needed pieces
        const needed = this.pieceManager.findNeeded();

        if (needed.length === 0 && this.activePieceIdx.size === 0) {
            this.emit('complete');
            return;
        }

        // Replenish existing active pieces in working set
        for (const pieceIdx of Array.from(this.activePieceIdx)) {
            if (this.pieceManager.hasPiece(pieceIdx)) {
                this.activePieceIdx.delete(pieceIdx);
                continue;
            }
            const unassignedBlocks = this.getUnassignedBlockForPiece(pieceIdx);
            if (unassignedBlocks.length > 0) {
                this.queuedRequests.push(...unassignedBlocks);
            }
        }

        // Snapshot 2: Peer records for working-set eligibility
        const availablePeers = this.peerPoolManager.getPeerRecords();

        // Expand working set up to MAX_WORKING_SET_PIECES
        while (this.activePieceIdx.size < this.MAX_WORKING_SET_PIECES) {
            const candidatePieces = needed.filter(idx => !this.activePieceIdx.has(idx));
            if (candidatePieces.length === 0) break;

            // Strategy dictates priority ordering based on index snapshots
            const prioritizedCandidates = this.getPrioritizedCandidates(candidatePieces);
            let selectedPiece: number | null = null;

            // Schedulability check: ensure at least one currently eligible peer possesses the piece
            for (const pieceIdx of prioritizedCandidates) {
                const hasEligiblePeer = availablePeers.some(peer =>
                    peer.lifecycleState === 'READY' &&
                    !peer.isChoked &&
                    (this.inflightRequestMap.get(peer.key)?.length ?? 0) < this.MAX_INFLIGHT_PER_PEER &&
                    peer.hasPiece(pieceIdx)
                );

                if (hasEligiblePeer) {
                    selectedPiece = pieceIdx;
                    break;
                }
            }

            // If the rarest needed pieces have no eligible peers, halt working-set expansion
            if (selectedPiece === null) break;

            const newBlocks = this.getUnassignedBlockForPiece(selectedPiece);

            if (newBlocks.length > 0) {
                this.activePieceIdx.add(selectedPiece);
                this.queuedRequests.push(...newBlocks);
            } else {
                break;
            }
        }

        // Dispatch queued requests
        this.dispatchQueuedRequests();
    }

    // --- AVAILABILITY INDEX MANAGEMENT ---

    private initializeAvailabilityTracking(): void {
        this.peersByPiece.clear();
        this.piecesByAvailability.clear();

        for (let pieceIdx = 0; pieceIdx < this.pieceCount; pieceIdx++) {
            this.peersByPiece.set(pieceIdx, new Set());
        }

        const records = this.peerPoolManager.getPeerRecords();
        for (const record of records) {
            for (let pieceIdx = 0; pieceIdx < this.pieceCount; pieceIdx++) {
                if (record.hasPiece(pieceIdx)) {
                    this.peersByPiece.get(pieceIdx)!.add(record.key);
                }
            }
        }

        for (let pieceIdx = 0; pieceIdx < this.pieceCount; pieceIdx++) {
            const count = this.peersByPiece.get(pieceIdx)!.size;
            this.addPieceToAvailabilityBucket(pieceIdx, count);
        }
    }

    private addPieceToAvailabilityBucket(pieceIdx: number, count: number): void {
        let bucket = this.piecesByAvailability.get(count);
        if (!bucket) {
            bucket = new Set<number>();
            this.piecesByAvailability.set(count, bucket);
        }
        bucket.add(pieceIdx);
    }

    private removePieceFromAvailabilityBucket(pieceIdx: number, count: number): void {
        const bucket = this.piecesByAvailability.get(count);
        if (bucket) {
            bucket.delete(pieceIdx);
            if (bucket.size === 0) {
                this.piecesByAvailability.delete(count);
            }
        }
    }

    private registerPeerPiece(peerKey: string, pieceIdx: number): void {
        const peerSet = this.peersByPiece.get(pieceIdx);
        if (!peerSet || peerSet.has(peerKey)) return;

        const oldCount = peerSet.size;
        peerSet.add(peerKey);
        const newCount = peerSet.size;

        this.removePieceFromAvailabilityBucket(pieceIdx, oldCount);
        this.addPieceToAvailabilityBucket(pieceIdx, newCount);
    }

    private unregisterPeerPiece(peerKey: string, pieceIdx: number): void {
        const peerSet = this.peersByPiece.get(pieceIdx);
        if (!peerSet || !peerSet.has(peerKey)) return;

        const oldCount = peerSet.size;
        peerSet.delete(peerKey);
        const newCount = peerSet.size;

        this.removePieceFromAvailabilityBucket(pieceIdx, oldCount);
        this.addPieceToAvailabilityBucket(pieceIdx, newCount);
    }

    private syncPeerBitfield(peerKey: string): void {
        const peer = this.peerPoolManager.getPeerRecords().find(p => p.key === peerKey);
        if (!peer) return;

        for (let pieceIdx = 0; pieceIdx < this.pieceCount; pieceIdx++) {
            const peerSet = this.peersByPiece.get(pieceIdx);
            if (!peerSet) continue;

            const hasPieceNow = peer.hasPiece(pieceIdx);
            const hadPieceBefore = peerSet.has(peerKey);

            if (hasPieceNow && !hadPieceBefore) {
                this.registerPeerPiece(peerKey, pieceIdx);
            } else if (!hasPieceNow && hadPieceBefore) {
                this.unregisterPeerPiece(peerKey, pieceIdx);
            }
        }
    }

    private handlePeerDropAvailability(peerKey: string): void {
        for (let pieceIdx = 0; pieceIdx < this.pieceCount; pieceIdx++) {
            this.unregisterPeerPiece(peerKey, pieceIdx);
        }
    }

    // --- STRATEGY CANDIDATE SELECTION ---

    private getPrioritizedCandidates(candidatePieces: number[]): number[] {
        switch (this.strategy) {
            case 'RANDOM_FIRST':
                return this.schedulerRandomFirstCandidates(candidatePieces);
            case 'RAREST_FIRST':
                return this.schedulerRarestFirstCandidates(candidatePieces);
            default:
                throw ErrorFactory.normalize(
                    new Error("The Scheduler is in an unsupported internal state")
                );
        }
    }

    private schedulerRandomFirstCandidates(pieces: number[]): number[] {
        const shuffled = [...pieces];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    private schedulerRarestFirstCandidates(pieces: number[]): number[] {
        const candidateSet = new Set(pieces);
        const prioritized: number[] = [];

        const sortedRarityKeys = Array.from(this.piecesByAvailability.keys()).sort((a, b) => a - b);

        for (const rarityLevel of sortedRarityKeys) {
            const pieceSet = this.piecesByAvailability.get(rarityLevel);
            if (!pieceSet || pieceSet.size === 0) continue;

            const tierMatches: number[] = [];
            for (const idx of pieceSet) {
                if (candidateSet.has(idx)) {
                    tierMatches.push(idx);
                }
            }

            for (let i = tierMatches.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tierMatches[i], tierMatches[j]] = [tierMatches[j], tierMatches[i]];
            }

            prioritized.push(...tierMatches);
        }

        return prioritized;
    }

    // --- BLOCK DISPATCH & QUEUING ---

    private getUnassignedBlockForPiece(pieceIdx: number): BlockRequest[] {
        const missingOffsets = this.pieceManager.getMissingOffsets(pieceIdx);
        const pieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;
        const unassigned: BlockRequest[] = [];

        for (const begin of missingOffsets) {
            const isQueued = this.queuedRequests.some(
                req => req.index === pieceIdx && req.begin === begin
            );
            if (isQueued) continue;

            const isInflight = Array.from(this.inflightRequestMap.values()).some(
                requests => requests.some(
                    req => req.index === pieceIdx && req.begin === begin
                )
            );
            if (isInflight) continue;

            const length = Math.min(BLOCK_SIZE, pieceSize - begin);
            unassigned.push({ index: pieceIdx, begin, length });
        }
        return unassigned;
    }

    private dispatchQueuedRequests(): void {
        if (this.queuedRequests.length === 0) return;

        // Dispatch fetches a fresh snapshot of peers to ensure requests 
        // are routed according to current capacity and connection state, 
        // distinct from the working-set expansion eligibility check.
        const activePeers = this.peerPoolManager.getPeerRecords();
        const remainingQueue: BlockRequest[] = [];

        for (const req of this.queuedRequests) {
            const candidateRecord = activePeers.find(record => {
                if (record.lifecycleState !== 'READY' || record.isChoked) return false;

                const inflightCount = this.inflightRequestMap.get(record.key)?.length ?? 0;
                if (inflightCount >= this.MAX_INFLIGHT_PER_PEER) return false;

                return record.hasPiece(req.index);
            });

            if (!candidateRecord) {
                remainingQueue.push(req);
                continue;
            }

            try {
                this.peerPoolManager.requestBlocks(
                    candidateRecord.key,
                    req.index,
                    req.begin,
                    req.length
                );

                const inflight = this.inflightRequestMap.get(candidateRecord.key) ?? [];
                inflight.push(req);
                this.inflightRequestMap.set(candidateRecord.key, inflight);
            } catch (err: any) {
                const code = err?.code;
                if (code === 'PEER_NOT_READY' || code === 'PEER_UNAVAILABLE') {
                    remainingQueue.push(req);
                } else {
                    throw err;
                }
            }
        }
        this.queuedRequests = remainingQueue;
    }

    // --- EVENT LISTENERS ---

    private attachListeners(): void {
        this.pieceManager.on('piece_verified', ({ index, buffer }) => {
            this.activePieceIdx.delete(index);
            this.queuedRequests = this.queuedRequests.filter(req => req.index !== index);

            if (!this.hasCompletedInitialPiece) {
                this.hasCompletedInitialPiece = true;
                this.strategy = 'RAREST_FIRST';
            }

            this.evaluateAllInterests();
            this.emit('piece_completed', { index, buffer });
            this.schedule();
        });

        this.pieceManager.on('piece_verification_failed', ({ index }) => {
            this.activePieceIdx.delete(index);
            this.schedule();
        });

        this.peerPoolManager.on('peer_ready', ({ key }) => {
            this.syncPeerBitfield(key);
            this.evaluateInterest(key);
            this.schedule();
        });

        this.peerPoolManager.on('block', ({ peerKey, index, begin, block }) => {
            // Data Integrity Model: The request is removed from inflight BEFORE acceptBlock.
            // If acceptBlock throws (e.g., bad bounds), the block is safely dropped here.
            // Because it is no longer inflight or queued, the next schedule() pass 
            // will detect the offset as missing and organically re-request it.
            const inflight = this.inflightRequestMap.get(peerKey) || [];
            this.inflightRequestMap.set(
                peerKey,
                inflight.filter(req => !(req.index === index && req.begin === begin))
            );

            try {
                this.pieceManager.acceptBlock(index, begin, block);
            } catch (err) {
                this.emit('error', err);
            }
            this.schedule();
        });

        this.peerPoolManager.on('peer_choked', ({ key }) => {
            this.requeueInflightRequests(key);
            this.schedule();
        });

        this.peerPoolManager.on('peer_unchoked', () => {
            this.schedule();
        });

        this.peerPoolManager.on('peer_have', ({ key, index }: { key: string; index: number }) => {
            this.registerPeerPiece(key, index);
            this.evaluateInterest(key);
            this.schedule();
        });

        this.peerPoolManager.on('peer_bitfield', ({ key }: { key: string }) => {
            this.syncPeerBitfield(key);
            this.evaluateInterest(key);
            this.schedule();
        });

        const handlePeerDrop = ({ key }: { key: string }) => {
            this.requeueInflightRequests(key);
            this.handlePeerDropAvailability(key);
            this.inflightRequestMap.delete(key);
            this.schedule();
        };

        this.peerPoolManager.on('peer_disconnected', handlePeerDrop);
        this.peerPoolManager.on('peer_failed', handlePeerDrop);
    }

    // --- INTEREST & INFLIGHT MANAGEMENT ---

    private evaluateInterest(key: string): void {
        const records = this.peerPoolManager.getPeerRecords();
        const peer = records.find(p => p.key === key);
        if (!peer) return;

        const needed = this.pieceManager.findNeeded();
        const hasNeededPiece = needed.some(idx => peer.hasPiece(idx));

        if (hasNeededPiece && !peer.amInterested) {
            this.peerPoolManager.expressInterest(key);
        } else if (!hasNeededPiece && peer.amInterested) {
            this.peerPoolManager.revokeInterest(key);
        }
    }

    private evaluateAllInterests(): void {
        const records = this.peerPoolManager.getPeerRecords();
        for (const record of records) {
            this.evaluateInterest(record.key);
        }
    }

    private requeueInflightRequests(key: string): void {
        const inflight = this.inflightRequestMap.get(key) || [];
        for (const req of inflight) {
            const isAlreadyQueued = this.queuedRequests.some(
                q => q.index === req.index && q.begin === req.begin
            );
            if (!isAlreadyQueued && this.pieceManager.isNeeded(req.index)) {
                this.queuedRequests.push(req);
            }
        }
        this.inflightRequestMap.set(key, []);
    }
}
