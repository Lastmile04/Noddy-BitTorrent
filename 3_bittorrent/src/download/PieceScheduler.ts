import { EventEmitter } from "node:stream";
import { PieceManager } from "./PieceManager.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { PieceSelector } from "./PieceSelector.js";
import { PieceSchedulerConfig, BlockRequest, WorkingPieceState, InflightBlockRequest, ReceivedBlock } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";


export class PieceScheduler extends EventEmitter {
    pieceLength: number;
    pieceCount: number;
    lastPieceLength: number;

    pieceManager: PieceManager;
    peerPoolManager: PeerPoolManager;
    pieceSelector: PieceSelector;

    requestQueue: BlockRequest[];
    inflightMap: Map<string, InflightBlockRequest>;

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
        this.inflightMap = new Map();

        this.workingPieceMap = new Map();

        this.MAX_REQUEST_PER_PEER = 8;
        this.BLOCK_SIZE = 16384;
        this.CURRENT_WORKING_LIMIT = 8;
    }

    public start(): void {

        this.attachListeners();
        this.schedule();
    }

    private schedule(): void {
        const needed = this.pieceManager.findNeeded();
        if (needed.length === 0) {
            this.emit('complete');
            return;
        }

        const selectionCount = this.CURRENT_WORKING_LIMIT - this.workingPieceMap.size;
        if (selectionCount > 0) {
            const selectedPieces = this.pieceSelector.select(needed, selectionCount);
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

        for (const [pieceIdx, peerKeySet] of pieceToPeers.entries()) {
            const validKeys = this.peerPoolManager.filterEligiblePeers(peerKeySet, this.MAX_REQUEST_PER_PEER);
            pieceToPeers.set(pieceIdx, validKeys);
        }

        return pieceToPeers;
    };

    private queueRequests(peersMap: Map<number, Set<string>>): void {
        for (const pieceIdx of peersMap.keys()) {
            const missingOffsets = this.pieceManager.getMissingOffsets(pieceIdx);
            for (const begin of missingOffsets) {
                const currentPieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;
                const length = Math.min(this.BLOCK_SIZE, currentPieceSize - begin);

                const inflightKey = `${pieceIdx}-${begin}`;
                if (this.inflightMap.has(inflightKey)) continue;
                const isAlreadyQueued = this.requestQueue.some(req => req.index === pieceIdx && req.begin === begin);
                if (isAlreadyQueued) continue;

                this.requestQueue.push({
                    index: pieceIdx,
                    begin,
                    length
                });
            }
        }
    }

    private dispatchQueuedRequests(peersMap: Map<number, Set<string>>): void {
        const deferredRequests: BlockRequest[] = [];

        while (this.requestQueue.length > 0) {
            const request: InflightBlockRequest = this.requestQueue.shift()!;
            const inflightKey = `${request.index}-${request.begin}`;

            // If it managed to slip into flight through another thread/event cycle, skip
            if (this.inflightMap.has(inflightKey)) {
                continue;
            }

            // Extract the list of "ip:port" keys representing peers that host this specific piece
            const validPeerKeys = peersMap.get(request.index);
            let assignedPeerKey: string | null = null;

            if (validPeerKeys) {
                for (const peerKey of validPeerKeys) {
                    // Check active queues using the exact "ip:port" identifier string
                    const activePipelineSize = this.peerPoolManager.getInflightRequestCount(peerKey);

                    if (activePipelineSize < this.MAX_REQUEST_PER_PEER) {
                        assignedPeerKey = peerKey;
                        break;
                    }
                }
            }

            if (assignedPeerKey) {
                // Attach network parameters to block instance
                request.peerKey = assignedPeerKey;
                request.sentAt = Date.now();

                // Track block globally inside the engine map before pushing onto network buffer
                this.inflightMap.set(inflightKey, request);

                // Dispatch the real TCP or uTP wire command out to the specific target peer
                this.peerPoolManager.requestBlocks(assignedPeerKey, request.index, request.begin, request.length);
            } else {
                // No peer pipeline room available; save request for the next scheduling sweep
                deferredRequests.push(request);
            }
        }

        // Return untouched block elements back to the engine queue
        this.requestQueue = deferredRequests;
    }

    private attachListeners(): void {

        // peerPoolManager events 
        this.peerPoolManager.on('block', (data) => this.handleBlockReceived(data));
        this.peerPoolManager.on('peer_ready', () => this.schedule());
        this.peerPoolManager.on('peer_unchoked', () => this.schedule());

        this.peerPoolManager.on('peer_choked', ({ key }) => {
            this.evictInflightForPeer(key);
            this.schedule();
        });

        this.peerPoolManager.on('peer_have', (data) => {
            this.pieceSelector.updatePieceToPeersMap(data.key, data.index);
        });

        this.peerPoolManager.on('peer_bitfield', (data) => {
            this.pieceSelector.updatePieceToPeersMap(data.key, data.bitfield);
        });

        const handlePeerRemoval = ({ key }: { key: string }) => {
            this.pieceSelector.removePeer(key);
            this.evictInflightForPeer(key);
            this.schedule();
        };

        this.peerPoolManager.on('peer_disconnected', handlePeerRemoval);
        this.peerPoolManager.on('peer_failed', handlePeerRemoval);

        // PieceManager
        this.pieceManager.on('piece_verified', (data) => this.handlePieceVerification(data));

        this.pieceManager.on('download_complete', () => {
            this.emit('download_complete');
        });

        this.pieceManager.on('piece_verification_failed', () => this.schedule());
        //NOTE: for verification fail later if possible I can add peer reputation to punish bad performing peers
    }

    private evictInflightForPeer(peerKey: string): void {
        for (const [inflightKey, block] of this.inflightMap.entries()) {
            if (block.peerKey === peerKey) {
                this.inflightMap.delete(inflightKey);
            }
        }
    }

    private handlePieceVerification(pieceIdx: number): void {
        if (this.workingPieceMap.has(pieceIdx)) this.workingPieceMap.delete(pieceIdx);

        for (const inflightBlock of this.inflightMap.values()) {
            if (inflightBlock.index === pieceIdx) {
                throw ErrorFactory.normalize("Error in internal inflightMap schdeuler logic");
            }
        };
        this.schedule();
    }

    private handleBlockReceived(data: ReceivedBlock): void {
        const inflightKey = `${data.index}-${data.begin}`;
        const inflightBlock = this.inflightMap.get(inflightKey);

        if (!inflightBlock) return;
        if (inflightBlock.peerKey !== data.peerKey) return;
        if (inflightBlock.length !== data.block.length) {
            this.inflightMap.delete(inflightKey);

            this.emit('error', ErrorFactory.network(
                'PROTOCOL_VIOLATION',
                `Block of invalid length sent by peer: ${inflightBlock.peerKey}`)
            );

            this.schedule();
            return;
        };

        try {
            this.pieceManager.acceptBlock(data.index, data.begin, data.block);
        } catch (err) {
            this.inflightMap.delete(inflightKey);
            this.emit('error', err);
            this.schedule();
            return;
        }

        this.inflightMap.delete(inflightKey);
        const pieceState = this.workingPieceMap.get(data.index);

        if (pieceState) {
            pieceState.lastProgressAt = Date.now();
        }

        this.schedule();
    }
}

