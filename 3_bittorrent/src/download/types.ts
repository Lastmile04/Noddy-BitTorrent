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
    readonly key: string;                // Endpoint identity (ip:port)
    readonly peerId?: Buffer;            // Protocol identity (handshaken remote 20-byte ID)
    readonly isEligible: boolean;        // Helper combining: ready state, socket unchoked, not destroying
    readonly isChoked: boolean;          // Peer is currently choking us
    readonly inflightRequests: number;  // Current size of outstanding requests map
    readonly downloadRate: number;       // Rolling bytes/sec speed metric
    /**
     * Efficiently queries if this peer possesses a specific piece index.
     * Delegates directly to BitTorrentPeer's bitfield buffer.
     */
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
