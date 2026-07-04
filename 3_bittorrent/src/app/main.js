// import net from 'net';

import { createClient } from './client.js';
import { generatePeerId } from '../identity/peerId.js';
import { parseTorrentFile } from './torrent-loader.js';
import { urlDispatcher } from '../tracker/urlDispatcher.js';
import { fileURLToPath } from 'url';
import path from 'path';

const port = 4000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const torrentPath = path.resolve(__dirname, '../../samples/debian.torrent');
const torrentMeta = parseTorrentFile(torrentPath);

const peerId = generatePeerId('PC', '0001');
const left = torrentMeta.totalLength;


// Static/identity -> peerID, port
// Torrnet Specific -> infoHash, left
// Session/dynamic -> uploaded, downloaded, event, numwant
const trackerParams = {
    infoHash: torrentMeta.infoHash,
    peerId,
    port,
    uploaded: 0,
    downloaded: 0,
    left,
    numwant: 50,
    event: 'started'
}

const result = await urlDispatcher(torrentMeta.announceList, trackerParams);

console.log('🌐 Tracker connected');
console.log(`👥 Peers discovered: ${result.peers.length}`);
console.log(`⏱ Announce interval: ${result.peerStats.interval}`);

// In this MVP I don't need to server behaviour and only need the client implemetation
// server implementation will be in future updates 
// const server = net.createServer((socket)=>{
//     console.log('Incoming peer connection:', socket.remoteAddress, socket.remotePort);

//     const btPeer = new BitTorrentPeer(socket, infoHash, peerId);
// });

const peerList = result.peers;
const handshake = await createClient(peerList, peerId, torrentMeta);
