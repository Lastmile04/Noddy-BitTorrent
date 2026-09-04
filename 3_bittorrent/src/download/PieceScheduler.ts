import EventEmitter from "node:events";
import { BlockRequest, DownloadMode, EligiblePeerCandidate, PeerRecord, PieceSchedulerConfig, SchedulerState } from "./types.js";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";

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
        this.updateSchedulerState(needed.length);

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

            if (record.lifecycleState !== 'READY') continue;
            if (record.isChoked) continue;

            const inflightCount = this.inflightRequestMap.get(record.key)?.length ?? 0;
            if (inflightCount >= this.MAX_INFLIGHT_PER_PEER) continue;

            const availablePieces = neededPieces.filter(pieceIdx => record.hasPiece(pieceIdx));
            if (availablePieces.length > 0) {
                candidates.push({
                    peer: record,
                    availablePieces
                });
            }
        }
        return candidates;
    }

    private updateSchedulerState(length: number): void { };

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

    private schedulerRandomFirst(eligibleCandidates: EligiblePeerCandidate[]): number { };
    private schedulerRarestFirst(eligibleCandidates: EligiblePeerCandidate[]): number { };
    private schedulerEndgame(eligibleCandidates: EligiblePeerCandidate[]): void { };
    private generateBlockRequest(pieceIdx: number): BlockRequest[] { };
    private handlePeerDisconnect(peerKey: string): void { };
    private dispatchQueuedRequests(): void { };

    private attachListeners(): void {
        // // Re-run schedule tick whenever peer pipeline space opens up or state changes
        // this.peerPoolManager.on('peer:unchoked', () => this.schedule());
        // this.peerPoolManager.on('peer:ready', () => this.schedule());
        //
        // this.pieceManager.on('block:written', () => this.schedule());
        // this.pieceManager.on('piece:completed', () => {
        //     this.downloadedPieceCount++;
        //     this.schedule();
        // });
    }

}
