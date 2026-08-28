import { Peer } from '../peers/types.js';
import { TorrentMeta } from '../app/types.js';

export interface DownloadManagerConfig {
    peerList: Peer[]
    peerId: Buffer
    torrentMeta: TorrentMeta
}

export interface ActivePiece {
    buffer: Buffer
    downloadedBytes: number
    receivedBlocks: Set<number>
}

export interface PieceManagerConfig {
    pieceLength: number
    pieceHashes: Buffer[]
    totalLength: number
    isMultiFile: boolean
    pieceCount: number
    lastPieceLength: number
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

