import { Peer } from '../peers/types.js';
import { TorrentMeta } from '../app/types.js';
import { LifecycleStateOpts } from '../transport/types.js';

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

export interface PeerRecord {
    readonly key: string;
    readonly peerId?: Buffer;
    readonly lifecycleState: LifecycleStateOpts;
    readonly isChoked: boolean;          // Remote peer is choking us
    readonly amInterested: boolean;      // We have expressed interest in remote peer
    readonly peerInterested: boolean;    // Remote peer has expressed interest in us
    readonly inflightRequests: number;
    readonly downloadRate: number;
    hasPiece(pieceIndex: number): boolean;
}

export interface PeerPoolConfig {
    infoHash: Buffer
    peerId: Buffer
    pieceLength: number
    totalLength: number
    pieceCount: number
    maxPeers?: number
}

export interface BlockEventReceived {
    peerKey: string
    index: number
    begin: number
    block: Buffer
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
}


