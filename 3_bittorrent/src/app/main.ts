import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';

import { generatePeerId } from '../identity/peerId.js';
import { parseTorrentFile } from './torrent-loader.js';
import { urlDispatcher } from '../tracker/urlDispatcher.js';
import { TrackerParams } from './types.js';
import { DownloadManager } from '../download/DownloadManager.js';

const port = 4000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printBanner(torrentName: string) {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                    🚀 NODDY BITTORRENT                   ║
║          BitTorrent Protocol Implementation              ║
╚══════════════════════════════════════════════════════════╝
📍 Target: ${torrentName}
`);
}

function printSummary(stats: {
    name: string;
    contacted: number;
    success: number;
    failed: number;
    verified: boolean;
    downloaded: number;
    elapsedSeconds: number;
}) {
    const avgSpeed = (stats.downloaded / (stats.elapsedSeconds || 1) / 1024 / 1024).toFixed(2);
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📥 DOWNLOAD SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 Torrent:              ${stats.name}
👥 Peers Contacted:      ${stats.contacted}
✅ Active/Connected:     ${stats.success}
❌ Failed Peers:         ${stats.failed}
🔐 Integrity Check:      ${stats.verified ? 'PASSED (SHA1)' : 'FAILED'}
📦 Total Downloaded:     ${(stats.downloaded / 1024 / 1024).toFixed(2)} MB
⏱️  Time Elapsed:       ${stats.elapsedSeconds.toFixed(1)}s
⚡ Average Speed:        ${avgSpeed} MB/s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function run() {
    const torrentPath: string = path.resolve(__dirname, '../../samples/debian.torrent');
    const torrentMeta = parseTorrentFile(torrentPath);

    printBanner(torrentMeta.name.toString());

    const peerId: Buffer = generatePeerId('PC', '0001');
    const totalLength: number = torrentMeta.totalLength;

    const trackerParams: TrackerParams = {
        infoHash: torrentMeta.infoHash,
        peerId,
        port,
        uploaded: 0,
        downloaded: 0,
        left: totalLength,
        numwant: 50,
        event: 'started',
    };

    console.log('🌐 Contacting tracker...');
    const result = await urlDispatcher(torrentMeta.announceList, trackerParams);

    // Filter out IPv6 peers to prevent hanging on unreachable routes
    const ipv4Peers = result.peers.filter((p: { ip: string }) => !p.ip.includes(':'));
    console.log(`👥 Peers discovered: ${result.peers.length} total (${ipv4Peers.length} IPv4 usable)`);
    console.log(`⏱ Announce interval: ${result.peerStats.interval}\n`);

    const download = new DownloadManager({ peerList: ipv4Peers, peerId, torrentMeta });

    let lastCompletedBytes = 0;
    let lastTickTime = Date.now();
    const startTime = Date.now();
    let currentSpeedMBs = 0;
    let lastActivePeers = 0;
    let lastFailedPeers = 0;

    // Periodic speed & progress ticker with precise delta-time measurement
    const speedInterval = setInterval(() => {
        const now = Date.now();
        const elapsedIntervalSeconds = (now - lastTickTime) / 1000;
        lastTickTime = now;

        const bytesDiff = download.session.completedBytes - lastCompletedBytes;
        lastCompletedBytes = download.session.completedBytes;

        currentSpeedMBs = elapsedIntervalSeconds > 0 ? (bytesDiff / elapsedIntervalSeconds) / 1024 / 1024 : 0;

        const downloadedMB = (download.session.completedBytes / 1024 / 1024).toFixed(2);
        const totalMB = (totalLength / 1024 / 1024).toFixed(2);
        const percent = totalLength > 0 ? ((download.session.completedBytes / totalLength) * 100).toFixed(1) : '0.0';

        lastActivePeers = download.session.activePeers ?? 0;
        lastFailedPeers = download.session.failedPeers;

        process.stdout.write(
            `\r\x1b[K📥 Progress: ${percent}% | Down: ${downloadedMB} / ${totalMB} MB | Speed: ${currentSpeedMBs.toFixed(2)} MB/s | Active Peers: ${lastActivePeers} | Failed: ${lastFailedPeers}`
        );
    }, 1000);

    // Listen to DownloadManager's native session updates
    download.on('sessionUpdate', (session) => {
        lastActivePeers = session.activePeers;
        lastFailedPeers = session.failedPeers;
    });

    download.on('completed', (session) => {
        clearInterval(speedInterval);
        const elapsedSeconds = (Date.now() - startTime) / 1000;

        console.log('\n\n\x1b[32m✅ Download completed and verified successfully!\x1b[0m');
        printSummary({
            name: torrentMeta.name.toString(),
            contacted: ipv4Peers.length,
            success: session.activePeers || 1,
            failed: session.failedPeers,
            verified: true,
            downloaded: session.completedBytes,
            elapsedSeconds,
        });
        process.exit(0);
    });

    download.on('error', (err: Error) => {
        clearInterval(speedInterval);
        console.error('\n\x1b[31m❌ Download Manager Error:\x1b[0m', err.message);
    });

    // Kick off the swarm download process
    await download.start();
}

run().catch((error) => {
    console.error('\x1b[31m❌ Fatal Client Error:\x1b[0m', error);
    process.exit(1);
});
