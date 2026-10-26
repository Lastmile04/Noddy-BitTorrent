import { EventEmitter } from "node:events";
import { Buffer } from 'buffer';

import os from 'os';
import path from 'path';
import { statfs } from "node:fs/promises";
import * as fs from 'fs/promises';

import { DownloadManagerConfig, PieceManagerConfig, DownloadSession, TorrentStorageConfig, ClientStateType, PeerPoolConfig, PieceSchedulerConfig } from './types.js';
import { Peer } from '../peers/types.js';
import { TorrentMeta } from "../app/types.js";

import { TorrentStorage } from "./TorrentStorage.js";
import { ErrorFactory } from "../errors/TorrentError.js";
import { PeerPoolManager } from "./PeerPoolManager.js";
import { PieceScheduler } from "./PieceScheduler.js";
import { PieceManager } from './PieceManager.js';
import { ChokingManager } from "./ChokingManager.js";
import { BitTorrentPeer } from "../transport/BitTorrentPeer.js";

export class DownloadManager extends EventEmitter {

    session: DownloadSession;
    peerList: Peer[];
    peerId: Buffer;
    torrentMeta: TorrentMeta;

    private readonly MAX_ACTIVE_PEER: number = 80;
    private ClinetState: ClientStateType = "UnInitialized";

    private initPromise: Promise<void> | null = null;
    private startPromise: Promise<void> | null = null;

    private ROOT_DIR: string | null = null;

    public torrentStorage!: TorrentStorage;
    public peerPoolManager!: PeerPoolManager;
    public pieceScheduler!: PieceScheduler;
    public pieceManager!: PieceManager;
    public chokingManager!: ChokingManager;

    constructor({ peerList, peerId, torrentMeta }: DownloadManagerConfig) {
        super();

        this.session = {
            torrentName: torrentMeta.name.toString(),
            totalLength: torrentMeta.totalLength,

            totalPeers: peerList.length,
            connectedPeers: 0,
            failedPeers: 0,
            activePeers: 0,

            downloadedBytes: 0,
            completedBytes: 0,
            status: "idle"
        };

        this.peerList = peerList;
        this.peerId = peerId;
        this.torrentMeta = torrentMeta;
    }

    public async init(): Promise<void> {
        if (this.ClinetState === "Initialized" || this.ClinetState === "Started") return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                this.ClinetState = "Initializing";
                if (this.ROOT_DIR === null) {
                    const homeDir = os.homedir();
                    this.ROOT_DIR = path.join(homeDir, 'Downloads', 'NoddyBitTorrent');
                }

                await fs.mkdir(this.ROOT_DIR, { recursive: true });
                const stats = await statfs(this.ROOT_DIR);
                const availableBytes = stats.bsize * stats.bavail;

                const safetyMarginBytes = 50 * 1024 * 1024;
                const totalRequiredBytes = this.torrentMeta.totalLength + safetyMarginBytes;

                if (availableBytes < totalRequiredBytes) {
                    throw ErrorFactory.normalize(
                        `Not enough disk space! Required ~${(totalRequiredBytes / (1024 * 1024)).toFixed(2)} MB ` +
                        `(including safety margin), but only ${(availableBytes / (1024 * 1024)).toFixed(2)} MB available.`
                    );
                }

                const storageData: TorrentStorageConfig = {
                    totalSize: this.torrentMeta.totalLength,
                    rootDir: this.ROOT_DIR!,
                    pieceLength: this.torrentMeta.pieceLength,
                    fileSpecs: this.torrentMeta.files
                };

                this.torrentStorage = new TorrentStorage(storageData);
                await this.torrentStorage.init();
                this.ClinetState = "Initialized";
            } catch (err) {
                this.ClinetState = "UnInitialized";
                this.session.status = "failed";
                this.initPromise = null;
                this.emit('error', err);
                throw err;
            }
        })();

        return this.initPromise;
    }

    public async start(): Promise<void> {
        if (this.ClinetState === 'Started') return;
        if (this.startPromise) return this.startPromise;

        this.startPromise = (async () => {
            try {
                await this.init();

                this.ClinetState = "Starting";

                // Construct Managers
                const pieceData: PieceManagerConfig = {
                    pieceLength: this.torrentMeta.pieceLength,
                    pieceHashes: this.torrentMeta.pieceHashes,
                    totalLength: this.torrentMeta.totalLength,
                    isMultiFile: this.torrentMeta.isMultiFile,
                    pieceCount: this.torrentMeta.pieceCount,
                    lastPieceLength: this.torrentMeta.lastPieceLength,
                    torrentStorage: this.torrentStorage
                };
                this.pieceManager = new PieceManager(pieceData);

                const peerPoolConfig: PeerPoolConfig = {
                    infoHash: this.torrentMeta.infoHash,
                    peerId: this.peerId,
                    pieceLength: this.torrentMeta.pieceLength,
                    totalLength: this.torrentMeta.totalLength,
                    pieceCount: this.torrentMeta.pieceCount,
                    maxPeers: this.MAX_ACTIVE_PEER,
                    isPieceNeeded: (index: number): boolean => {
                        return this.pieceManager.isNeeded(index);
                    }
                };
                this.peerPoolManager = new PeerPoolManager(peerPoolConfig);

                const pieceSchedulerConfig: PieceSchedulerConfig = {
                    pieceManager: this.pieceManager,
                    peerPoolManager: this.peerPoolManager,
                    pieceLength: this.torrentMeta.pieceLength,
                    lastPieceLength: this.torrentMeta.lastPieceLength,
                    totalSize: this.torrentMeta.totalLength,
                    pieceCount: this.torrentMeta.pieceCount
                };
                this.pieceScheduler = new PieceScheduler(pieceSchedulerConfig);

                this.chokingManager = new ChokingManager(this.peerPoolManager);

                // Attach Listeners ONCE here during construction phase to prevent duplicate bindings on retry
                this.attachListeners();

                this.ClinetState = 'Started';
                this.session.status = "downloading";
                this.emit('sessionUpdate', this.session);

                this.downloadPhase();
            } catch (err) {
                this.startPromise = null;
                this.ClinetState = this.torrentStorage ? "Initialized" : "UnInitialized";

                this.session.status = "failed";
                this.emit('sessionUpdate', this.session);
                throw err;
            }
        })();

        return this.startPromise;
    }

    private downloadPhase(): void {
        this.pieceManager.init();
        for (const peer of this.peerList) {
            this.peerPoolManager.connectToPeer(peer.ip, peer.port);
        }

        this.pieceScheduler.start();
        this.chokingManager.start();

    }

    private handlePeerError = ({ peer, error }: { peer: BitTorrentPeer, error: Error }) => {
        this.session.failedPeers++;
        this.session.activePeers = Math.max(0, this.session.activePeers - 1);

        console.warn(`[DownloadManager] Peer error from ${peer.remotePeerState.ip}:${peer.remotePeerState.port}: ${error.message}`);
        this.emit('sessionUpdate', this.session);
    };

    private handlePiecePersisted = (idx: number) => {
        let persistedBytes: number = this.torrentMeta.pieceLength;
        if (idx === this.torrentMeta.pieceCount - 1) persistedBytes = this.torrentMeta.lastPieceLength;
        this.session.completedBytes += persistedBytes;
        this.peerPoolManager.announcePiece(idx);
        this.emit('sessionUpdate', this.session);
    };

    private handleStorageWriteFailed = ({ idx, torrentErr }: { idx: number, torrentErr: any }) => {
        console.error(`[DownloadManager] Failed to write piece ${idx}: ${torrentErr.message}`);

        if (torrentErr.code === 'ENOSPC') {
            console.warn(`[DownloadManager] Disk is full! Halting download session.`);
            this.haltDownload();
        }

        this.session.status = 'failed';
        this.emit('error', torrentErr);
        this.emit('sessionUpdate', this.session);
    };

    private handlePieceHashVerified = (idx: number) => {
        this.emit('piece_hash_verified', idx);
    };

    private handleSchedulerError = (err: any) => {
        if (err.code === 'PROTOCOL_VIOLATION') {
            this.session.failedPeers++;
            console.warn(`[DownloadManager] Protocol violation caught: ${err.message}`);
            this.emit('sessionUpdate', this.session);
        } else if (err.code === 'INVARIANT_VIOLATION' || err.code === 'SCHEDULER_STATE') {
            console.error(`[DownloadManager] CRITICAL Scheduler invariant error: ${err.message}`);

            this.session.status = 'failed';
            this.emit('error', err);
            this.emit('sessionUpdate', this.session);
        } else {
            console.error(`[DownloadManager] Unhandled scheduler error:`, err);
        }
    };

    private handleSchedulerComplete = () => {
        this.session.status = 'seeding';
        this.session.completedBytes = this.session.totalLength;

        console.log(`[DownloadManager] Download complete! Transitioning to Seeding mode for: ${this.session.torrentName}`);

        if (this.pieceScheduler) {
            this.pieceScheduler.stop();
        }
        this.chokingManager.switchPhase();
        this.emit('completed', this.session);
        this.emit('sessionUpdate', this.session);
    };

    private attachListeners(): void {
        if (this.peerPoolManager) {
            this.peerPoolManager.on('peer_error', this.handlePeerError);
        }

        if (this.pieceManager) {
            this.pieceManager.on('piece_persisted', this.handlePiecePersisted);
            this.pieceManager.on('storage_write_failed', this.handleStorageWriteFailed);
            this.pieceManager.on('piece_hash_verified', this.handlePieceHashVerified);
        }

        if (this.pieceScheduler) {
            this.pieceScheduler.on('error', this.handleSchedulerError);
            this.pieceScheduler.on('complete', this.handleSchedulerComplete);
        }
    }

    private detachListeners(): void {
        if (this.peerPoolManager) {
            this.peerPoolManager.off('peer_error', this.handlePeerError);
        }

        if (this.pieceManager) {
            this.pieceManager.off('piece_persisted', this.handlePiecePersisted);
            this.pieceManager.off('storage_write_failed', this.handleStorageWriteFailed);
            this.pieceManager.off('piece_hash_verified', this.handlePieceHashVerified);
        }

        if (this.pieceScheduler) {
            this.pieceScheduler.off('error', this.handleSchedulerError);
            this.pieceScheduler.off('complete', this.handleSchedulerComplete);
        }
    }

    private haltDownload(): void {
        // Stop active scheduling and choking loops to halt disk/network activity
        if (this.pieceScheduler) {
            this.pieceScheduler.stop();
        }
        if (this.chokingManager) {
            this.chokingManager.stop();
        }
        if (this.peerPoolManager) {
            this.peerPoolManager.shutdown();
        }
        if (this.torrentStorage) {
            this.torrentStorage.close();
        }

        this.detachListeners();
    }

    public async stop(): Promise<void> {
        if (this.ClinetState !== 'Started') return;
        this.haltDownload();
        this.ClinetState = 'Initialized'; // or 'UnInitialized' depending on design
        this.session.status = 'idle'; // or 'stopped'
        this.startPromise = null;
        this.emit('sessionUpdate', this.session);
    }
}
