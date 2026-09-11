import { EventEmitter } from "node:stream";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { PieceSchedulerConfig, BlockRequest, PeerRecord, SchedulablePiece } from "./types.js";

type status = 'QUEUED' | 'IN-FLIGHT';

export class PieceScheduler extends EventEmitter {
    pieceLength: number;
    pieceCount: number;
    lastPieceLength: number;

    pieceManager: PieceManager;
    peerPoolManager: PeerPoolManager;

    requestQueue: BlockRequest[];

    MAX_REQUEST_PER_PEER: number;
    BLOCK_SIZE: number;

    blockStatusMap: Map<string, status>;
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

        this.requestQueue = [];

        this.blockStatusMap = new Map();

        this.MAX_REQUEST_PER_PEER = 8;
        this.BLOCK_SIZE = 16384;
    }

    public schedule(): void {
        const needed = this.pieceManager.findNeeded();
        if (needed.length === 0) {
            this.emit('complete');
            return;
        }
        const peers = this.peerPoolManager.getPeerRecords();
        const schedulable = this.findSchedulablePiece(peers, needed);

        if (schedulable.piece === null || schedulable.eligiblePeers.length === 0) return;

        this.queueRequests(schedulable.piece);
        this.dispatchQueuedRequests(schedulable.eligiblePeers);
    }

    private queueRequests(piece: number): void {
        const missingBlocks = this.pieceManager.getMissingOffsets(piece);
        for (const begin of missingBlocks) {

            const pieceSize = piece === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;
            const remainingBytes = pieceSize - begin;
            const blockSize = Math.min(this.BLOCK_SIZE, remainingBytes);

            const blockKey = `${piece}:${begin}`;
            if (this.blockStatusMap.has(blockKey)) continue;

            this.requestQueue.push({
                index: piece,
                begin,
                length: blockSize
            });
            this.blockStatusMap.set(blockKey, 'QUEUED');
        }
    }

    private dispatchQueuedRequests(peers: PeerRecord[]): void {
        for (const peer of peers) {

            if (peer.inflightRequests >= this.MAX_REQUEST_PER_PEER) continue;

            const remainingSlots = this.MAX_REQUEST_PER_PEER - peer.inflightRequests;
            const queued = this.requestQueue.splice(0, remainingSlots);

            for (let i = 0; i < queued.length; i++) {

                const req = queued[i];
                const blockKey = `${req.index}:${req.begin}`;
                try {
                    this.peerPoolManager.requestBlocks(
                        peer.key,
                        req.index,
                        req.begin,
                        req.length
                    );
                } catch(err){
                // if a socket error then rescheduler since the peer might be faulty
                // if just a random error then simply requeue the request and change the status 
                // if a metadata error then propogate since the error should not be possible because of all the checks and other invariants and it should be shown to the developer for the issue to be dealth with  
                }
                this.blockStatusMap.set(blockKey, 'IN-FLIGHT');
            }
        }
    };

    private findSchedulablePiece(peers: PeerRecord[], pieces: number[]): SchedulablePiece {
        for (const piece of pieces) {
            const peerList = peers.filter(peer => peer.hasPiece(piece) && peer.isChoked === false && peer.lifecycleState === 'READY' && peer.inflightRequests < this.MAX_REQUEST_PER_PEER);
            if (peerList.length >= 1) {
                return {
                    piece,
                    eligiblePeers: peerList
                }
            }
        }
        return {
            piece: null,
            eligiblePeers: []
        }
    }

}
