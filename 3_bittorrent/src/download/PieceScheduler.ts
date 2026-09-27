import { EventEmitter } from "node:events";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { PieceSelector } from "./PieceSelector.js";
import {
    PieceSchedulerConfig,
    BlockRequest,
    WorkingPieceState,
    InflightBlockRequest,
    ReceivedBlock,
    PeerHandlers,
    PieceHandler
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
    public readonly totalSize: number;

    public readonly pieceManager: PieceManager;
    public readonly peerPoolManager: PeerPoolManager;
    public readonly pieceSelector: PieceSelector;

    private requestQueue: BlockRequest[];
    private inflightMap: Map<string, InflightBlockRequest>;
    private workingPieceMap: Map<number, WorkingPieceState>;
    private queuedSet: Set<string> = new Set();

    private mode: SchedulerMode = SchedulerMode.BEGIN;

    private boundPeerHandlers!: PeerHandlers;
    private boundPieceHandlers!: PieceHandler;

    // Operational Tunables
    private readonly MAX_REQUEST_PER_PEER: number = 8;
    private readonly BLOCK_SIZE: number = 16384;
    private readonly CURRENT_WORKING_LIMIT: number = 8;
    private readonly BLOCK_TIMEOUT_MS: number = 15000;
    private FINISHED_BLOCKS: number = 0;
    public readonly TOTAL_BLOCKS: number;

    // Lifecycle State Flags
    private isRunning: boolean = false;
    private isDestroyed: boolean = false;
    private isScheduling = false;
    private isSchedulePending = false;

    constructor({
        pieceManager,
        peerPoolManager,
        pieceLength,
        pieceCount,
        lastPieceLength,
        totalSize
    }: PieceSchedulerConfig) {
        super();
        this.pieceCount = pieceCount;
        this.pieceLength = pieceLength;
        this.lastPieceLength = lastPieceLength;
        this.totalSize = totalSize;

        this.TOTAL_BLOCKS = Math.ceil(this.totalSize / this.BLOCK_SIZE);

        this.pieceManager = pieceManager;
        this.peerPoolManager = peerPoolManager;
        this.pieceSelector = new PieceSelector(pieceCount);

        this.requestQueue = [];
        this.inflightMap = new Map();
        this.workingPieceMap = new Map();
        this.initBoundHandlers();
    }

    public start(): void {
        if (this.isDestroyed) {
            throw ErrorFactory.scheduler_state(
                'SCHEDULER_DESTROYED',
                'Cannot start a destroyed scheduler instance'
            )
        };
        if (this.isRunning) return;

        this.isRunning = true;
        this.attachListeners();
        this.schedule();
    }

    public stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.detachListeners();

        this.requestQueue = [];
        this.inflightMap.clear();
        this.workingPieceMap.clear();
        this.queuedSet.clear();
    }

    public destroy(): void {
        this.stop();
        this.isDestroyed = true;
        this.removeAllListeners();
    }

    public getMode(): SchedulerMode {
        return this.mode;
    }

    private schedule(): void {
        if (!this.isRunning || this.isDestroyed) return;

        // If already running, flag that another pass is needed and exit early
        if (this.isScheduling) {
            this.isSchedulePending = true;
            return;
        }

        this.isScheduling = true;

        try {
            // Keep running passes as long as synchronous re-entrant events request it
            do {
                this.isSchedulePending = false;

                this.sweepStaleInflightRequests();

                const needed = this.pieceManager.findNeeded();
                if (needed.length === 0) {
                    this.emit('complete');
                    return;
                }

                const selectionCapacity = this.CURRENT_WORKING_LIMIT - this.workingPieceMap.size;
                if (selectionCapacity > 0) {
                    const selectedPieces = this.selectPiecesForWorkingSet(needed, selectionCapacity);
                    this.addWorkingPiece(selectedPieces);
                }

                const eligiblePeers = this.getEligiblePeers();
                this.queueRequests();
                this.dispatchQueuedRequests(eligiblePeers);

            } while (this.isSchedulePending && this.isRunning && !this.isDestroyed);

        } finally {
            this.isScheduling = false;
            this.isSchedulePending = false;
        }
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
                if (this.inflightMap.has(inflightKey) || this.queuedSet.has(inflightKey)) continue;

                this.requestQueue.push({ index: pieceIdx, begin, length });
                this.queuedSet.add(inflightKey);

                if (this.TOTAL_BLOCKS - this.FINISHED_BLOCKS <= this.inflightMap.size + this.requestQueue.length) {
                    this.mode = SchedulerMode.ENDGAME;
                }
            }
        }
    }

    private dispatchQueuedRequests(pieceToPeersMap: Map<number, Set<string>>): void {
        const deferredRequests: BlockRequest[] = [];

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift()!;
            const inflightKey = `${request.index}-${request.begin}`;
            this.queuedSet.delete(inflightKey);
            let inflightEntry = this.inflightMap.get(inflightKey);

            // In NORMAL mode, if the block is already actively inflight with any peer, skip re-dispatch
            if (this.mode === SchedulerMode.NORMAL && inflightEntry) {
                continue;
            }

            const validPeerKeys = pieceToPeersMap.get(request.index);

            if (validPeerKeys) {
                for (const peerKey of validPeerKeys) {
                    // Skip if this specific peer already has an active inflight request for this block
                    // For Endgame
                    if (inflightEntry?.peers.has(peerKey)) continue;

                    const activePipelineSize = this.peerPoolManager.getInflightRequestCount(peerKey);
                    if (activePipelineSize < this.MAX_REQUEST_PER_PEER) {

                        // ATTEMPT WIRE DISPATCH FIRST
                        try {
                            this.peerPoolManager.requestBlocks(
                                peerKey,
                                request.index,
                                request.begin,
                                request.length
                            );
                        } catch (err) {
                            // Wire request failed synchronously (e.g., socket closed, PEER_NOT_READY)
                            // Do NOT record this peer in inflight state; try next eligible peer
                            continue;
                        }

                        // WIRE SUCCESS: Record peer in inflight state
                        if (!inflightEntry) {
                            inflightEntry = {
                                ...request,
                                peers: new Map<string, number>()
                            };
                            this.inflightMap.set(inflightKey, inflightEntry);
                        }

                        inflightEntry.peers.set(peerKey, Date.now());

                        // In NORMAL mode: enforce 1 block -> 1 peer max (halt peer loop)
                        // In ENDGAME mode: NO break statement -> fan out to remaining eligible peers
                        if (this.mode === SchedulerMode.NORMAL) break;
                    }
                }
            }

            // INVARIANT CHECK: Is this block covered by AT LEAST ONE active peer request?
            const isCoveredInflight = inflightEntry;

            // If no peer is currently requesting this block (neither previously nor newly assigned),
            // defer it back to the requestQueue so it is never dropped.
            if (!isCoveredInflight) deferredRequests.push(request);
        }

        this.requestQueue = deferredRequests;
    }

    private sweepStaleInflightRequests(): void {
        const now = Date.now();
        for (const [key, req] of this.inflightMap.entries()) {
            for (const [peerKey, timestamp] of req.peers.entries()) {
                if (timestamp && (now - timestamp > this.BLOCK_TIMEOUT_MS)) {
                    req.peers.delete(peerKey);
                }
            }

            if (req.peers.size === 0) this.inflightMap.delete(key);
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
        for (const [key, req] of this.inflightMap.entries()) {
            req.peers.delete(peerKey);
            if (req.peers.size === 0) this.inflightMap.delete(key);
        }
    }

    private initBoundHandlers(): void {
        const handlePeerRemoval = ({ key }: { key: string }) => {
            if (!this.isRunning) return;
            this.pieceSelector.removePeer(key);
            this.evictInflightForPeer(key);
            this.schedule();
        };

        this.boundPeerHandlers = {
            block: (data) => this.handleBlockReceived(data),
            peerReady: () => this.schedule(),
            peerUnchoked: () => this.schedule(),

            peerHave: (data) => {
                this.pieceSelector.updatePieceToPeersMap(data.key, data.index);
                this.schedule();
            },

            peerBitfield: (data) => {
                this.pieceSelector.updatePieceToPeersMap(data.key, data.bitfield);
                this.schedule();
            },

            peerChoked: ({ key }) => {
                this.evictInflightForPeer(key);
                this.schedule();
            },

            peerDisconnected: handlePeerRemoval,
            peerFailed: handlePeerRemoval,
        };

        this.boundPieceHandlers = {
            verified: (pieceIdx) => this.handlePieceVerification(pieceIdx),
            failed: (pieceIdx) => {
                // Calculate blocks contained in this piece and deduct from FINISHED_BLOCKS
                const currentPieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;
                const blocksInPiece = Math.ceil(currentPieceSize / this.BLOCK_SIZE);

                // Subtract only blocks that were previously accounted for
                const missingOffsets = this.pieceManager.getMissingOffsets(pieceIdx);
                const receivedBlocksInPiece = blocksInPiece - missingOffsets.length;
                this.FINISHED_BLOCKS = Math.max(0, this.FINISHED_BLOCKS - receivedBlocksInPiece);

                this.evictInflightForPiece(pieceIdx);
                this.schedule();
            },
            complete: () => {
                this.emit('download_complete');
            }
        };
    }

    private attachListeners(): void {
        const ppm = this.peerPoolManager;
        ppm.on('block', this.boundPeerHandlers.block);
        ppm.on('peer_ready', this.boundPeerHandlers.peerReady);
        ppm.on('peer_unchoked', this.boundPeerHandlers.peerUnchoked);
        ppm.on('peer_have', this.boundPeerHandlers.peerHave);
        ppm.on('peer_bitfield', this.boundPeerHandlers.peerBitfield);
        ppm.on('peer_choked', this.boundPeerHandlers.peerChoked);
        ppm.on('peer_disconnected', this.boundPeerHandlers.peerDisconnected);
        ppm.on('peer_failed', this.boundPeerHandlers.peerFailed);

        const pm = this.pieceManager;
        pm.on('piece_verified', this.boundPieceHandlers.verified);
        pm.on('piece_verification_failed', this.boundPieceHandlers.failed);
        pm.on('download_complete', this.boundPieceHandlers.complete);
    }

    private detachListeners(): void {
        const ppm = this.peerPoolManager;
        ppm.off('block', this.boundPeerHandlers.block);
        ppm.off('peer_ready', this.boundPeerHandlers.peerReady);
        ppm.off('peer_unchoked', this.boundPeerHandlers.peerUnchoked);
        ppm.off('peer_have', this.boundPeerHandlers.peerHave);
        ppm.off('peer_bitfield', this.boundPeerHandlers.peerBitfield);
        ppm.off('peer_choked', this.boundPeerHandlers.peerChoked);
        ppm.off('peer_disconnected', this.boundPeerHandlers.peerDisconnected);
        ppm.off('peer_failed', this.boundPeerHandlers.peerFailed);

        const pm = this.pieceManager;
        pm.off('piece_verified', this.boundPieceHandlers.verified);
        pm.off('piece_verification_failed', this.boundPieceHandlers.failed);
        pm.off('download_complete', this.boundPieceHandlers.complete);
    }

    private handlePieceVerification(pieceIdx: number): void {
        this.workingPieceMap.delete(pieceIdx);
        this.evictInflightForPiece(pieceIdx);
        this.schedule();
    }

    private handleBlockReceived(data: ReceivedBlock): void {
        const inflightKey = `${data.index}-${data.begin}`;
        const inflightBlock = this.inflightMap.get(inflightKey);

        if (!inflightBlock || !inflightBlock.peers.has(data.peerKey)) return;

        if (inflightBlock.length !== data.block.length) {
            this.evictInflightForPeer(data.peerKey);
            this.emit('error', ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                `Block of invalid length sent by peer: ${data.peerKey}`
            ));
            this.schedule();
            return;
        }

        try {
            this.pieceManager.acceptBlock(data.index, data.begin, data.block);
        } catch (err) {
            this.evictInflightForPeer(data.peerKey);
            this.emit('error', err);
            this.schedule();
            return;
        }

        for (const peerKey of inflightBlock.peers.keys()) {
            if (peerKey !== data.peerKey) {
                this.peerPoolManager.cancelRequest(
                    peerKey,
                    data.index,
                    data.begin,
                    data.block.length
                );
            }
        }

        this.inflightMap.delete(inflightKey);
        this.FINISHED_BLOCKS += 1;

        const pieceState = this.workingPieceMap.get(data.index);
        if (pieceState) {
            pieceState.lastProgressAt = Date.now();
        }

        this.schedule();
    }
}
