import { EventEmitter } from "node:stream";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { PieceSelector } from "./PieceSelector.js";
import { PieceSchedulerConfig, BlockRequest, PeerRecord, WorkingPieceState } from "./types.js";


export class PieceScheduler extends EventEmitter {
    pieceLength: number;
    pieceCount: number;
    lastPieceLength: number;

    pieceManager: PieceManager;
    peerPoolManager: PeerPoolManager;
    pieceSelector: PieceSelector;

    requestQueue: BlockRequest[];


    MAX_REQUEST_PER_PEER: number;
    BLOCK_SIZE: number;
    CURRENT_WORKING_LIMIT: number;


    workingPieceMap: Map<number, WorkingPieceState>;
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

        this.workingPieceMap = new Map();

        this.MAX_REQUEST_PER_PEER = 8;
        this.BLOCK_SIZE = 16384;
        this.CURRENT_WORKING_LIMIT = 8;
    }

    public schedule(): void {
        const needed = this.pieceManager.findNeeded();
        if (needed.length === 0) {
            this.emit('complete');
            return;
        }
        const peers = this.peerPoolManager.getPeerRecords();

        const selectionCount = this.CURRENT_WORKING_LIMIT - this.workingPieceMap.size;
        if (selectionCount > 0) {
            const selectedPieces = this.pieceSelector.select(needed, peers, selectionCount);
            this.addWorkingPiece(selectedPieces);
        }

        const eligiblePeers = this.getEligiblePeers();

        this.queueRequests(eligiblePeers);
        this.dispatchQueuedRequests(eligiblePeers);
    }

    private addWorkingPiece(pieceIdxArray: number[]): void {
        if (pieceIdxArray.length > this.CURRENT_WORKING_LIMIT) return;

        for (const pieceIdx of pieceIdxArray) {
            if (this.workingPieceMap.has(pieceIdx)) continue;
            this.workingPieceMap.set(pieceIdx, {
                addedAt: Date.now(),
                lastProgressAt: Date.now()
            });
        }
    };

    private getEligiblePeers(): Map<number, Set<string>> {
        const pieces = Array.from(this.workingPieceMap.keys());
        const pieceToPeers = this.pieceSelector.getSources(pieces);

        for (const pieceIdx of pieceToPeers.keys()) {
            const peerKeySet = pieceToPeers.get(pieceIdx);
            const validKeys = this.peerPoolManager.filterEligiblePeers(peerKeySet, this.MAX_REQUEST_PER_PEER);
            pieceToPeers.set(pieceIdx, validKeys);
        }

        return pieceToPeers;
    };

    private queueRequests(peersMap: Map<number, Set<number>>): void {

    }

    private dispatchQueuedRequests(peersMap: Map<number, Set<number>>): void {

    };
}
