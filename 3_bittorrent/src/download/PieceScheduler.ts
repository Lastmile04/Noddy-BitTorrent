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

    private readonly MAX_INFLIGHT_PER_PEER = 5;

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

        if (this.queuedRequests.length === 0 && needed.length > 0) {

            const activePeers = this.peerPoolManager.getPeerRecords();
            const eligibleCandidates = this.filterEligiblePeers(activePeers, needed);

            if (eligibleCandidates.length === 0) return;

            const targetPiece = this.selectPiece(eligibleCandidates);
            this.queuedRequests.push(...this.generateBlockRequest(targetPiece));
        }

        this.dispatchQueuedRequests();
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
            length: pieceSize
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
