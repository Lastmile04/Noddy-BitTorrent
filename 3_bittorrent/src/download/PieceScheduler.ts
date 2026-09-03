import EventEmitter from "node:events";
import { BlockRequest, EligiblePeerCandidate, PeerRecord, PieceSchedulerConfig, SchedulerState } from "./types.js";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";

export class PieceScheduler extends EventEmitter {
    pieceLength: number;
    pieceCount: number;
    lastPieceLength: number;
    pieceManager: PieceManager;
    peerPoolManager: PeerPoolManager;
    queuedRequests: BlockRequest[];
    schedulerState: SchedulerState;
    private inflightRequestMap: Map<string, BlockRequest[]>;
    private isRunning: boolean;

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
        this.schedulerState = 'RANDOM_FIRST';
        this.isRunning = false;
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

        if (this.schedulerState === 'COMPLETE') {
            this.isRunning = false;
            this.emit('complete');
            return;
        }

        const activePeers = this.peerPoolManager.getPeerRecords();
        const eligibleCandidates = this.filterEligiblePeers(activePeers, needed);

        if (eligibleCandidates.length === 0) return;

        switch (this.schedulerState) {
            case 'RANDOM_FIRST':
                this.schedulerRandomFirst(eligibleCandidates);
                break;
            case 'RAREST_FIRST':
                this.schedulerRarestFirst(eligibleCandidates);
                break;
            case 'ENDGAME':
                this.schedulerEndgame(eligibleCandidates);
                break;
        }
    }

    private filterEligiblePeers(records: PeerRecord[], neededPieces: number[]): EligiblePeerCandidate[] {
        const candidates: EligiblePeerCandidate[] = [];
        for (const record of records) {

            if (record.lifecycleState !== 'READY') continue;
            if (record.isChoked) continue;
            if (record.inflightRequests >= this.MAX_INFLIGHT_PER_PEER) continue;

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
    private schedulerRandomFirst(eligibleCandidates: EligiblePeerCandidate[]): void { };
    private schedulerRarestFirst(eligibleCandidates: EligiblePeerCandidate[]): void { };
    private schedulerEndgame(eligibleCandidates: EligiblePeerCandidate[]): void { };

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
