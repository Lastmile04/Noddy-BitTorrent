import net from 'net';
import { BitTorrentPeer } from '../transport/BitTorrentPeer.js';
import { PieceManager } from './PieceManager.js';
import { Spinner } from '../presentation/spinner.js';
import { Buffer } from 'buffer';

import { DownloadManagerConfig, PieceManagerConfig, DownloadSession } from './types.js';
import { PeerConfig } from '../transport/types.js';
import { torrentMetadataExtraction } from '../app/torrent-metadata.js';

export async function downloadManager({ peerList, peerId, torrentMeta }: DownloadManagerConfig): Promise<void> {
    const session: DownloadSession = {
        torrentName: torrentMeta.name.toString(),
        totalLength: torrentMeta.totalLength,

        totalPeers: peerList.length,
        connectedPeers: 0,
        failedPeers: 0,
        activePeers: 0,

        downloadedBytes: 0,
        completedBytes: 0,
        status: "idle"
    }

    const pieceData: PieceManagerConfig = {
        pieceLength: torrentMeta.pieceLength,
        pieceHashes: [Buffer.alloc(0)],
        totalLength: peerList.length,
        isMultiFile: torrentMeta.isMultifile,
        pieceCount: torrentMeta.pieceCount
    }

    const pieceStats = new PieceManager(pieceData);

    for (const peer of peerList) {
        if (session.activePeers > 40) { };
        const socket = new net.Socket();

        const peerData: PeerConfig = {
            socket: socket,
            pstr: "BitTorrent Protocol",
            peer: peer,
            peerId: peerId,
            infoHash: torrentMeta.infoHash,
            pieceLength: torrentMeta.pieceLength,
            totalLength: torrentMeta.totalLength
        }
        const peerStats = new BitTorrentPeer(peerData);
        session.activePeers++;

        //NOTE: have to connect to spinner or something else of the persentation layer will figure out later

        try {
            const res = await peerStats.connect();







        }
