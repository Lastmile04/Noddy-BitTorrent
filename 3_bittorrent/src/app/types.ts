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
