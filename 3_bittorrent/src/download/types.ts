import { Peer } from '../peers/types.js';
import { TorrentMeta } from '../app/types.js';
import { PieceManager } from './PieceManager.js';
import { PeerPoolManager } from './PeerPoolManager.js';
import { TorrentStorage } from './TorrentStorage.js';
import { TorrentFileSpec } from '../app/types.js';

// DOWNLOAD_MANAGER

export interface DownloadManagerConfig {
    peerList: Peer[]
    peerId: Buffer
    torrentMeta: TorrentMeta
}

export interface DownloadSession {
    torrentName: string
    totalLength: number

    totalPeers: number
    connectedPeers: number
    failedPeers: number
    activePeers: number

    downloadedBytes: number
    completedBytes: number

    status: "idle" | "downloading" | "completed" | "failed"
}

// PIECE_MANAGER

export interface ActivePiece {
    buffer: Buffer
    downloadedBytes: number
    receivedBlocks: Set<number> // set of begin offsets
}

export interface PieceManagerConfig {
    pieceLength: number
    pieceHashes: Buffer[]
    totalLength: number
    isMultiFile: boolean
    pieceCount: number
    lastPieceLength: number
    torrentStorage: TorrentStorage
    initialVerifiedPieces?: number[];
}

// PEER_POOL_MANAGER

export interface PeerPoolConfig {
    infoHash: Buffer
    peerId: Buffer
    pieceLength: number
    totalLength: number
    pieceCount: number
    maxPeers?: number
    isPieceNeeded: (index: number) => boolean;
}


export interface PeerBlockPayload {
    index: number
    begin: number
    block: Buffer
}

export interface PoolListeners {
    block: (data: PeerBlockPayload) => void,
    error: (err?: Error) => void,
    closed: () => void
    ready: () => void
    choke: () => void
    unchoke: () => void
    have: (index: number) => void
    bitfield: (bitfield: Buffer) => void
}

// PIECE_SCHEDULER

export interface PieceSchedulerConfig {
    pieceLength: number
    pieceCount: number
    lastPieceLength: number
    totalSize: number
    pieceManager: PieceManager
    peerPoolManager: PeerPoolManager
}

export interface BlockRequest {
    index: number
    begin: number
    length: number
}

export type DownloadMode = 'ACTIVE' | 'ENDGAME' | 'COMPLETE';
export type PieceStrategy = 'RANDOM_FIRST' | 'RAREST_FIRST';

export interface WorkingPieceState {
    addedAt: number,
    lastProgressAt: number,
    receivedBlocksCount: number
}

export interface InflightBlockRequest extends BlockRequest {
    peers: Map<string, number>  // peerKey ("ip:port") -> sentAt (timestamp)
}

export interface ReceivedBlock {
    peerKey: string,
    index: number,
    begin: number,
    block: Buffer,
}

export interface PeerHandlers {
    block(data: ReceivedBlock): void;
    peerReady(): void;
    peerUnchoked(): void;
    peerHave(data: { key: string; index: number }): void;
    peerBitfield(data: { key: string; bitfield: Buffer }): void;
    peerChoked(data: { key: string }): void;
    peerDisconnected(data: { key: string }): void;
    peerFailed(data: { key: string }): void;
}

export interface PieceHandler {
    verified: (pieceIdx: number) => void;
    failed: (pieceIdx: number) => void;
    complete: () => void;
}

// TORRENT_STORAGE

export interface TorrentStorageConfig {
    totalSize: number,
    rootDir: string,
    pieceLength: number,
    fileSpecs: TorrentFileSpec[]
}

export interface FileSlice {
    fullPath: string;
    fileOffset: number;
    bytesToProcess: number;
}
