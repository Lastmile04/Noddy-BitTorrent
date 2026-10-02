import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Standard ES module resolution for JS imports
import { generatePeerId } from '../identity/peerId.js';
import { parseTorrentFile } from './torrent-loader.js';
import { urlDispatcher } from '../tracker/urlDispatcher.js';
import { TrackerParams } from './types.js';
import { DownloadManager } from '../download/DownloadManager.js';

const port = 4000;
process.env.UV_THREADPOOL_SIZE = '64';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const torrentPath: string = path.resolve(__dirname, '../../samples/debian.torrent');

const torrentMeta = parseTorrentFile(torrentPath);

const peerId: Buffer = generatePeerId('PC', '0001');
const left: number = torrentMeta.totalLength;

// Static/identity -> peerID, port
// Torrent Specific -> infoHash, left
// Session/dynamic -> uploaded, downloaded, event, numwant
const trackerParams: TrackerParams = {
    infoHash: torrentMeta.infoHash,
    peerId,
    port,
    uploaded: 0,
    downloaded: 0,
    left,
    numwant: 50,
    event: 'started',
};

// Dispatch call to your JS module
const result = await urlDispatcher(torrentMeta.announceList, trackerParams);

console.log('🌐 Tracker connected');
console.log(`👥 Peers discovered: ${result.peers.length}`);
console.log(`⏱ Announce interval: ${result.peerStats.interval}`);

const peerList = result.peers;
const download = new DownloadManager({ peerList, peerId, torrentMeta });
