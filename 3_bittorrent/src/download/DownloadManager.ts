import { EventEmitter } from "node:stream";
import net from 'net';
import { BitTorrentPeer } from '../transport/BitTorrentPeer.js';
import { PieceManager } from './PieceManager.js';
import { Spinner } from '../presentation/spinner.js';
import { Buffer } from 'buffer';

import { DownloadManagerConfig, PieceManagerConfig, DownloadSession } from './types.js';
import { PeerConfig } from '../transport/types.js';
import { Peer } from '../peers/types.js';
import { TorrentMeta } from "../app/types.js";

export class DownloadManager extends EventEmitter {

    session: DownloadSession
    peerList: Peer[]
    pieceManager: PieceManager
    peerId: Buffer
    torrentMeta: TorrentMeta
    MAX_ACTIVE_PEER: number

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

        this.MAX_ACTIVE_PEER = 80;
        this.peerList = peerList;
        this.peerId = peerId;
        this.torrentMeta = torrentMeta;

        const pieceData: PieceManagerConfig = {
            pieceLength: torrentMeta.pieceLength,
            pieceHashes: torrentMeta.pieceHashes,
            totalLength: torrentMeta.totalLength,
            isMultiFile: torrentMeta.isMultiFile,
            pieceCount: torrentMeta.pieceCount,
            lastPieceLength: torrentMeta.lastPieceLength
        };

        this.pieceManager = new PieceManager(pieceData);
    }
}

