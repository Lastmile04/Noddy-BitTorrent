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
import { ErrorFactory, TorrentError } from "../errors/TorrentError.js";

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
    private readonly WORKING_PIECE_TIMEOUT_MS: number = 60000;
    private FINISHED_BLOCKS: number = 0;
    public readonly TOTAL_BLOCKS: number;

    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private readonly SWEEP_INTERVAL_MS: number = 5000;

    // Lifecycle State Flags
    private isRunning: boolean = false;
    private isDestroyed: boolean = false;
    private isScheduling = false;
    private isSchedulePending = false;
    private hasEmittedComplete = false;

    // Metrics
    public metrics = {
        totalDispatches: 0,
        retransmissions: 0,        // Re-dispatched after timeout or peer loss
        duplicateDispatches: 0,    // Speculative multi-dispatch in ENDGAME
        duplicateBlocks: 0         // Late block arrivals already fulfilled
    };

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

    private static getBlockKey(index: number, begin: number): string {
        return `${index}:${begin}`;
    }

    public start(): void {
        if (this.isDestroyed) {
            throw ErrorFactory.scheduler_state(
                'SCHEDULER_DESTROYED',
                'Cannot start a destroyed scheduler instance'
            );
        }
        if (this.isRunning) return;

        this.isRunning = true;
        this.hasEmittedComplete = false;
        this.attachListeners();

        this.startSweepTimer();
        this.schedule();
    }

    public stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.detachListeners();
        this.stopSweepTimer();
        this.resetSemantics();
    }

    private resetSemantics(): void {
        this.requestQueue = [];
        this.inflightMap.clear();
        this.workingPieceMap.clear();
        this.queuedSet.clear();
        this.FINISHED_BLOCKS = 0;
        this.mode = SchedulerMode.BEGIN;
    }

    private startSweepTimer(): void {
        this.stopSweepTimer();
        this.sweepTimer = setInterval(() => {
            if (this.isRunning && !this.isDestroyed) {
                this.sweepStaleInflightRequests();
            }
        }, this.SWEEP_INTERVAL_MS);
    }

    private stopSweepTimer(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
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
        if (!this.isRunning || this.isDestroyed || this.hasEmittedComplete) return;

        if (this.isScheduling) {
            this.isSchedulePending = true;
            return;
        }

        this.isScheduling = true;

        try {
            do {
                this.isSchedulePending = false;
                this.evictUnusableWorkingPieces();

                const needed = this.pieceManager.findNeeded();
                if (needed.length === 0) return;

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

    private evictUnusableWorkingPieces(): boolean {
        const now = Date.now();
        let evictedAny = false;

        for (const [pieceIndex, state] of this.workingPieceMap.entries()) {
            const hasAvailablePeer = this.pieceSelector.hasPeers(pieceIndex);
            const hasInflight = this.hasInflightBlocksForPiece(pieceIndex);

            const isOrphaned = !hasAvailablePeer && !hasInflight;
            const isStale = (now - state.lastProgressAt > this.WORKING_PIECE_TIMEOUT_MS) && !hasInflight;

            if (isOrphaned || isStale) {
                this.evictWorkingPiece(pieceIndex);
                evictedAny = true;
            }
        }

        return evictedAny;
    }

    private evictWorkingPiece(pieceIndex: number): void {
        this.workingPieceMap.delete(pieceIndex);
        this.requestQueue = this.requestQueue.filter((req) => req.index !== pieceIndex);

        const prefix = `${pieceIndex}:`;
        for (const key of this.queuedSet) {
            if (key.startsWith(prefix)) {
                this.queuedSet.delete(key);
            }
        }
    }

    private selectPiecesForWorkingSet(needed: number[], limit: number): number[] {
        if (limit <= 0) return [];
        const candidates = needed.filter(
            (index) =>
                index >= 0 &&
                index < this.pieceCount &&
                this.pieceSelector.availabilityArray[index] > 0 &&
                !this.workingPieceMap.has(index)
        );

        if (candidates.length === 0) return [];

        if (this.mode === SchedulerMode.BEGIN) {
            const shuffled = [...candidates];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled.slice(0, limit);
        }
        return this.pieceSelector.select(candidates, limit);
    }

    private addWorkingPiece(pieceIdxArray: number[]): void {
        for (const pieceIdx of pieceIdxArray) {
            if (this.workingPieceMap.has(pieceIdx)) continue;
            this.workingPieceMap.set(pieceIdx, {
                addedAt: Date.now(),
                lastProgressAt: Date.now(),
                receivedBlocksCount: 0
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

                const blockKey = PieceScheduler.getBlockKey(pieceIdx, begin);
                if (this.inflightMap.has(blockKey) || this.queuedSet.has(blockKey)) continue;

                this.requestQueue.push({ index: pieceIdx, begin, length });
                this.queuedSet.add(blockKey);
            }
        }

        // Active work = inflight blocks + queue depth. Trigger ENDGAME when remaining unverified blocks fit within pipeline.
        const remainingUnverifiedBlocks = this.TOTAL_BLOCKS - this.FINISHED_BLOCKS;
        const activeBlocksCount = this.inflightMap.size + this.requestQueue.length;

        if (remainingUnverifiedBlocks <= activeBlocksCount && this.mode !== SchedulerMode.ENDGAME) {
            this.mode = SchedulerMode.ENDGAME;
        }
    }

    private dispatchQueuedRequests(pieceToPeersMap: Map<number, Set<string>>): void {
        const deferredRequests: BlockRequest[] = [];

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift()!;
            const blockKey = PieceScheduler.getBlockKey(request.index, request.begin);

            this.queuedSet.delete(blockKey);

            let inflightEntry = this.inflightMap.get(blockKey);
            if (this.mode !== SchedulerMode.ENDGAME && inflightEntry) {
                continue;
            }

            const validPeerKeys = pieceToPeersMap.get(request.index);

            if (validPeerKeys) {
                for (const peerKey of validPeerKeys) {
                    if (inflightEntry?.peers.has(peerKey)) continue;

                    const activePipelineSize = this.peerPoolManager.getInflightRequestCount(peerKey);
                    if (activePipelineSize >= this.MAX_REQUEST_PER_PEER) continue;

                    try {
                        this.peerPoolManager.requestBlocks(
                            peerKey,
                            request.index,
                            request.begin,
                            request.length
                        );

                        this.metrics.totalDispatches++;
                        if (inflightEntry) {
                            this.metrics.duplicateDispatches++;
                        } else {
                            inflightEntry = {
                                ...request,
                                peers: new Map<string, number>()
                            };
                            this.inflightMap.set(blockKey, inflightEntry);
                        }

                        inflightEntry.peers.set(peerKey, Date.now());

                        // Single-dispatch per block in BEGIN/NORMAL mode
                        if (this.mode !== SchedulerMode.ENDGAME) break;

                    } catch (err) {
                        if (this.isNetworkOrPeerDispatchError(err)) {
                            this.evictInflightForPeer(peerKey);
                            continue;
                        }
                        throw err;
                    }
                }
            }

            const isCoveredInflight = inflightEntry && inflightEntry.peers.size > 0;
            if (!isCoveredInflight) {
                deferredRequests.push(request);
            }
        }

        this.requestQueue = deferredRequests;
    }

    private sweepStaleInflightRequests(): void {
        const now = Date.now();
        let hasEvictions = false;

        for (const [key, req] of this.inflightMap.entries()) {
            for (const [peerKey, timestamp] of req.peers.entries()) {
                if (timestamp && (now - timestamp > this.BLOCK_TIMEOUT_MS)) {
                    req.peers.delete(peerKey);
                    this.peerPoolManager.removeOutstandingRequestsFromPeer(peerKey, key);
                    this.metrics.retransmissions++;
                    hasEvictions = true;
                }
            }

            if (req.peers.size === 0) {
                this.inflightMap.delete(key);
            }
        }

        if (hasEvictions) this.schedule();
    }

    private evictInflightForPiece(pieceIdx: number): void {
        for (const [key, block] of this.inflightMap.entries()) {
            if (block.index === pieceIdx) {
                this.inflightMap.delete(key);
                for (const peerKey of block.peers.keys()) {
                    this.peerPoolManager.removeOutstandingRequestsFromPeer(peerKey, key);
                }
            }
        }
    }

    private evictInflightForPeer(peerKey: string): void {
        for (const [key, req] of this.inflightMap.entries()) {
            if (req.peers.has(peerKey)) {
                req.peers.delete(peerKey);
                if (req.peers.size === 0) {
                    this.inflightMap.delete(key);
                }
            }
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
                const pieceState = this.workingPieceMap.get(pieceIdx);
                if (pieceState) {
                    this.FINISHED_BLOCKS = Math.max(0, this.FINISHED_BLOCKS - pieceState.receivedBlocksCount);
                    this.workingPieceMap.delete(pieceIdx);
                }

                this.evictInflightForPiece(pieceIdx);
                this.schedule();
            },
            complete: () => this.handleDownloadComplete()
        };
    }

    private handlePieceVerification(pieceIdx: number): void {
        if (this.mode === SchedulerMode.BEGIN) this.mode = SchedulerMode.NORMAL;
        this.workingPieceMap.delete(pieceIdx);
        this.evictInflightForPiece(pieceIdx);
        this.schedule();
    }

    private handleBlockReceived(data: ReceivedBlock): void {
        const blockKey = PieceScheduler.getBlockKey(data.index, data.begin);
        const inflightBlock = this.inflightMap.get(blockKey);

        if (!inflightBlock || !inflightBlock.peers.has(data.peerKey)) {
            this.metrics.duplicateBlocks++;
            return;
        }

        if (inflightBlock.length !== data.block.length) {
            this.evictInflightForPeer(data.peerKey);
            this.emit('error', ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                `Block of invalid length sent by peer: ${data.peerKey}`
            ));
            this.schedule();
            return;
        }

        const pieceState = this.workingPieceMap.get(data.index);
        if (!pieceState) {
            this.evictInflightForPeer(data.peerKey);
            this.emit('error', ErrorFactory.scheduler_state(
                'INVARIANT_VIOLATION',
                `Received block for piece ${data.index} which is not in workingPieceMap`
            ));
            this.schedule();
            return;
        }

        this.FINISHED_BLOCKS += 1;
        pieceState.lastProgressAt = Date.now();
        pieceState.receivedBlocksCount += 1;

        try {
            this.pieceManager.acceptBlock(data.index, data.begin, data.block);
        } catch (err) {
            this.FINISHED_BLOCKS = Math.max(0, this.FINISHED_BLOCKS - 1);
            pieceState.receivedBlocksCount = Math.max(0, pieceState.receivedBlocksCount - 1);

            inflightBlock.peers.delete(data.peerKey);
            this.peerPoolManager.removeOutstandingRequestsFromPeer(data.peerKey, blockKey);

            if (this.isPeerDataOrProtocolError(err)) {
                this.evictInflightForPeer(data.peerKey);
            }

            this.emit('error', err);
            this.schedule();
            return;
        }

        const isStillWorking = this.workingPieceMap.has(data.index);
        const isPieceVerified = this.pieceManager.hasPiece(data.index);

        if (!isStillWorking && !isPieceVerified) {
            this.schedule();
            return;
        }

        if (isPieceVerified) this.workingPieceMap.delete(data.index);

        // Cancel redundant requests sent during ENDGAME mode to other peers
        if (this.mode === SchedulerMode.ENDGAME && inflightBlock.peers.size > 1) {
            for (const peerKey of inflightBlock.peers.keys()) {
                if (peerKey !== data.peerKey) {
                    try {
                        this.peerPoolManager.cancelRequest(
                            peerKey,
                            data.index,
                            data.begin,
                            data.block.length
                        );
                    } catch {
                        // Suppress cancellation errors for dropping/disconnected peers
                    }
                }
            }
        }

        this.inflightMap.delete(blockKey);
        this.schedule();
    }

    private handleDownloadComplete(): void {
        if (this.hasEmittedComplete) return;

        this.hasEmittedComplete = true;
        this.isRunning = false;
        this.stopSweepTimer();
        this.detachListeners();

        this.requestQueue = [];
        this.inflightMap.clear();
        this.workingPieceMap.clear();
        this.queuedSet.clear();

        this.emit('scheduler_complete');
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

    private isPeerDataOrProtocolError(err: unknown): boolean {
        if (!(err instanceof TorrentError)) return false;

        if (err.domain === 'NETWORK' || err.domain === 'SOCKET' || err.domain === 'PEER_STATE') {
            return true;
        }

        if (err.domain === 'PIECE_STATE') {
            return (
                err.code === 'INVALID_BLOCK_SIZE' ||
                err.code === 'UNALIGNED_BLOCK' ||
                err.code === 'INVALID_BEGIN' ||
                err.code === 'INVALID_PIECE_INDEX' ||
                err.code === 'INVALID_ACTIVE_PIECE'
            );
        }

        return false;
    }

    private isNetworkOrPeerDispatchError(err: unknown): boolean {
        if (!(err instanceof TorrentError)) return false;

        return (
            err.domain === 'NETWORK' ||
            err.domain === 'SOCKET' ||
            err.domain === 'PEER_STATE'
        );
    }

    private hasInflightBlocksForPiece(pieceIndex: number): boolean {
        for (const req of this.inflightMap.values()) {
            if (req.index === pieceIndex && req.peers.size > 0) {
                return true;
            }
        }
        return false;
    }
}
