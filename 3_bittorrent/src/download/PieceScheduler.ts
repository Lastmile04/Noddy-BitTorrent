import EventEmitter from "node:events";
import { BlockRequest, DownloadMode, EligiblePeerCandidate, PeerRecord, PieceSchedulerConfig, PieceStrategy } from "./types.js";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";

const BLOCK_SIZE = 16384;

export class PieceScheduler extends EventEmitter {
    pieceLength: number;
    pieceCount: number;
    lastPieceLength: number;
    pieceManager: PieceManager;
    peerPoolManager: PeerPoolManager;
    queuedRequests: BlockRequest[];

    private inflightRequestMap: Map<string, BlockRequest[]>;
    private isRunning: boolean;
    private mode: DownloadMode;
    private strategy: PieceStrategy;
    private activePieceIdx: Set<number>;
    private hasCompletedInitialPiece: boolean;

    private readonly MAX_INFLIGHT_PER_PEER = 5;
    private readonly MAX_WORKING_SET_PIECES = 8;

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
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.attachListeners();
        this.schedule();
    }

    private schedule(): void {
        if (!this.isRunning) return;

        // Invariant: Scheduling pass evaluates against one immutable state snapshot
        const needed = this.pieceManager.findNeeded();

        if (needed.length === 0 && this.activePieceIdx.size === 0) {
            this.emit('complete');
            return;
        }

        // 1. Replenish existing active pieces in working set
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

        const activePeers = this.peerPoolManager.getPeerRecords();

        // 2. Expand working set up to MAX_WORKING_SET_PIECES
        while (this.activePieceIdx.size < this.MAX_WORKING_SET_PIECES) {
            const candidatePieces = needed.filter(idx => !this.activePieceIdx.has(idx));
            if (candidatePieces.length === 0) break;

            const eligibleCandidates = this.filterEligiblePeers(activePeers, candidatePieces);
            if (eligibleCandidates.length === 0) break;

            const targetPiece = this.selectPiece(eligibleCandidates);
            const newBlocks = this.getUnassignedBlockForPiece(targetPiece);

            // Working set invariant: only add piece if actionable unassigned blocks exist
            if (newBlocks.length > 0) {
                this.activePieceIdx.add(targetPiece);
                this.queuedRequests.push(...newBlocks);
            } else {
                break;
            }
        }

        // 3. Dispatch queued requests via single canonical path
        this.dispatchQueuedRequests();
    }

    private getUnassignedBlockForPiece(pieceIdx: number): BlockRequest[] {
        // Invariant failure in PieceManager must bubble up and fail loudly
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

    private filterEligiblePeers(records: PeerRecord[], neededPieces: number[]): EligiblePeerCandidate[] {
        const candidates: EligiblePeerCandidate[] = [];

        for (const record of records) {
            if (record.lifecycleState !== 'READY' || record.isChoked) continue;

            const inflightCount = this.inflightRequestMap.get(record.key)?.length ?? 0;
            if (inflightCount >= this.MAX_INFLIGHT_PER_PEER) continue;

            const availablePieces = neededPieces.filter(pieceIdx => record.hasPiece(pieceIdx));
            if (availablePieces.length > 0) {
                candidates.push({ peer: record, availablePieces });
            }
        }
        return candidates;
    }

    private selectPiece(candidates: EligiblePeerCandidate[]): number {
        switch (this.strategy) {
            case 'RANDOM_FIRST':
                return this.schedulerRandomFirst(candidates);
            case 'RAREST_FIRST':
                return this.schedulerRarestFirst(candidates);
            default:
                return candidates[0].availablePieces[0];
        }
    }

    private schedulerRandomFirst(candidates: EligiblePeerCandidate[]): number {
        const availablePieceSet = new Set<number>();
        for (const candidate of candidates) {
            for (const pieceIdx of candidate.availablePieces) {
                availablePieceSet.add(pieceIdx);
            }
        }
        const allAvailablePieces = Array.from(availablePieceSet);
        const randomIdx = Math.floor(Math.random() * allAvailablePieces.length);
        return allAvailablePieces[randomIdx];
    }

    private schedulerRarestFirst(candidates: EligiblePeerCandidate[]): number {
        const rarityMap = new Map<number, number>();
        for (const candidate of candidates) {
            for (const pieceIdx of candidate.availablePieces) {
                rarityMap.set(pieceIdx, (rarityMap.get(pieceIdx) ?? 0) + 1);
            }
        }

        let tiedPieces: number[] = [];
        let lowestCount = Infinity;
        for (const [pieceIdx, count] of rarityMap.entries()) {
            if (count < lowestCount) {
                lowestCount = count;
                tiedPieces = [pieceIdx];
            } else if (count === lowestCount) {
                tiedPieces.push(pieceIdx);
            }
        }
        const randomIndex = Math.floor(Math.random() * tiedPieces.length);
        return tiedPieces[randomIndex];
    }

    private dispatchQueuedRequests(): void {
        if (this.queuedRequests.length === 0) return;

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
                // Requeue strictly on explicit transient conditions
                if (code === 'PEER_NOT_READY' || code === 'PEER_UNAVAILABLE') {
                    remainingQueue.push(req);
                } else {
                    // Fail loudly on unexpected exceptions or domain violations
                    throw err;
                }
            }
        }
        this.queuedRequests = remainingQueue;
    }

    private attachListeners(): void {
        // --- PIECE MANAGER EVENTS ---

        this.pieceManager.on('piece_verified', ({ index, buffer }) => {
            this.activePieceIdx.delete(index);
            this.queuedRequests = this.queuedRequests.filter(req => req.index !== index);

            // Strategy transitions to RAREST_FIRST on verified milestone
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

        // --- PEER POOL MANAGER EVENTS ---

        this.peerPoolManager.on('peer_ready', ({ key }) => {
            this.evaluateInterest(key);
            this.schedule();
        });

        this.peerPoolManager.on('block', ({ peerKey, index, begin, block }) => {
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

        this.peerPoolManager.on('peer_have', ({ key }) => {
            this.evaluateInterest(key);
            this.schedule();
        });

        this.peerPoolManager.on('peer_bitfield', ({ key }) => {
            this.evaluateInterest(key);
            this.schedule();
        });

        const handlePeerDrop = ({ key }: { key: string }) => {
            this.requeueInflightRequests(key);
            this.inflightRequestMap.delete(key);
            this.schedule();
        };

        this.peerPoolManager.on('peer_disconnected', handlePeerDrop);
        this.peerPoolManager.on('peer_failed', handlePeerDrop);
    }

    // --- PRIVATE HELPERS ---

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
