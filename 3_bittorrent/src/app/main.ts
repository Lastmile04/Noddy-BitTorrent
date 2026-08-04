import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Standard ES module resolution for JS imports
import { createClient } from './client.js';
import { generatePeerId } from '../identity/peerId.js';
import { parseTorrentFile } from './torrent-loader.js';
import { urlDispatcher } from '../tracker/urlDispatcher.js';
import { downloadManager } from '../download/DownloadManger.js';
import { TrackerParams } from './types.js'; 

//import type { TorrentMetadata } from '../codec/ast.js'; // Use your extracted TorrentMetadata interface
const port = 4000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const torrentPath: string = path.resolve(__dirname, '../../samples/debian.torrent');

// TypeScript automatically infers the return type from parseTorrentFile if allowed,
// or you can explicitly type it with your TorrentMetadata interface:
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
await createClient(peerList, peerId, torrentMeta);
await downloadManager({ peerList, peerId, torrentMeta });
