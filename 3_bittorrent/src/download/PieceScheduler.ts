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

    private readonly MAX_INFLIGHT_PER_PEER = 5;
    private readonly MAX_CONCURRENT_PIECES = 8;

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
    }



    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.attachListeners();
        this.schedule();
    }

    private schedule(): void {
        if (!this.isRunning) return;

        const needed = this.pieceManager.findNeeded();
        this.updateSchedulerStrategy(needed.length);

        if (needed.length === 0 && this.activePieceIdx) {
            this.emit('complete');
            return;
        }

        // REPLENISH EXISTING ACTIVE PIECES 
        for (const pieceIdx of Array.from(this.activePieceIdx)) {
            if (this.pieceManager.hasPiece(pieceIdx)) {
                this.activePieceIdx.delete(pieceIdx);
                continue;
            }
            const unassignedBlocks = this.getUnassignedBlockForPiece(pieceIdx);
            if (unassignedBlocks.length > 0) this.queuedRequests.push(...unassignedBlocks);
        }

        const activePeers = this.peerPoolManager.getPeerRecords();

        // EXPAND ACTIVE PIECES *if below concurrency cap
        while (this.activePieceIdx.size < this.MAX_CONCURRENT_PIECES && needed.length > 0) {
            // filter pieces that aren't already active
            const candidatePieces = needed.filter(idx => !this.activePieceIdx.has(idx));
            if (candidatePieces.length === 0) break;

            const eligibleCandidates = this.filterEligiblePeers(activePeers, candidatePieces);
            if (eligibleCandidates.length === 0) break;

            const targetPiece = this.selectPiece(eligibleCandidates);
            this.activePieceIdx.add(targetPiece);

            const newBlocks = this.getUnassignedBlockForPiece(targetPiece);
            this.queuedRequests.push(...newBlocks);
        }
        this.dispatchQueuedRequests();
    }

    private getUnassignedBlockForPiece(pieceIdx: number): BlockRequest[] {
        const missingOffsets = this.pieceManager.getMissingOffsets(pieceIdx);
        const pieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;

        const unassigned: BlockRequest[] = [];

        for (const begin of missingOffsets) {
            // check if already in queue
            const isQueued = this.queuedRequests.some(
                req => req.index === pieceIdx && req.begin === begin
            );
            if (isQueued) continue;

            // check if currently in-flight
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
    };

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

    private updateSchedulerStrategy(length: number): void {
        if (length > 1 && this.strategy === 'RANDOM_FIRST') this.strategy = 'RAREST_FIRST';
    }


    private selectPiece(candidates: EligiblePeerCandidate[]): number {
        switch (this.strategy) {
            case 'RANDOM_FIRST':
                return this.schedulerRandomFirst(candidates);
            case 'RAREST_FIRST':
                return this.schedulerRarestFirst(candidates);
            default:
                return candidates[0].availablePieces[0]; // Fallback
        }
    }

    private schedulerRandomFirst(candidates: EligiblePeerCandidate[]): number {
        const availablePieceSet: Set<number> = new Set();
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
        const rarityMap: Map<number, number> = new Map();
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
            }
            else if (count === lowestCount) {
                tiedPieces.push(pieceIdx);
            }
        }
        const randomIndex = Math.floor(Math.random() * tiedPieces.length);
        return tiedPieces[randomIndex];
    }

    private generateBlockRequest(pieceIdx: number): BlockRequest[] {
        const missingOffsets = this.pieceManager.getMissingOffsets(pieceIdx);
        const pieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;

        return missingOffsets.map(begin => ({
            index: pieceIdx,
            begin,
            length: Math.min(BLOCK_SIZE, pieceSize - begin)
        }));
    };

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

            if (candidateRecord) {
                const inflight = this.inflightRequestMap.get(candidateRecord.key) ?? [];
                try {
                    this.peerPoolManager.requestBlocks(
                        candidateRecord.key,
                        req.index,
                        req.begin,
                        req.length
                    );

                    inflight.push(req);
                    this.inflightRequestMap.set(candidateRecord.key, inflight);
                }
                catch (err) {
                    remainingQueue.push(req);
                }
            } else {
                remainingQueue.push(req);
            }
        }
        this.queuedRequests = remainingQueue;
    }

    private attachListeners(): void {

    }

}
