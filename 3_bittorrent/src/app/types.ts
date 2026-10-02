export interface TorrentMeta {
    infoHash: Buffer;
    name: string;
    pieceLength: number;
    lastPieceLength: number;
    pieceHashes: Buffer[];
    pieceCount: number;
    totalLength: number;
    isMultiFile: boolean;
    announceList: string[][]
    files: TorrentFileSpec[]
}

export interface TrackerParams {
    infoHash: Buffer;
    peerId: Buffer;
    port: number;
    uploaded: number;
    downloaded: number;
    left: number;
    numwant: number;
    event: 'started' | 'stopped' | 'completed';
}

export interface TorrentFileSpec {
    path: string[];       // Subdirectories + filename
    length: number;       // Size in bytes
    startOffset: number;  // Inclusive global start byte offset
    endOffset: number;    // Exclusive global end byte offset
}
