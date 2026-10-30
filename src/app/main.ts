import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'node:fs/promises';

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

// Helper utility to safely prompt user with a fresh readline interface each time
async function askUser(query: string): Promise<string> {
    const rl = readline.createInterface({ input, output });
    try {
        return await rl.question(query);
    } finally {
        rl.close();
    }
}

async function run() {
    // --- PATH CONFIGURATION ---
    // const defaultTorrentPath = path.resolve(__dirname, '../samples/debian.torrent');
    const defaultTorrentPath = path.resolve(__dirname, '../../samples/debian.torrent');
    const defaultDownloadDir = path.resolve(process.cwd(), 'downloads');

    let torrentMeta: any;
    let totalLength = 0;
    let peers: any[] = [];

    // Handle Ctrl+C cleanly
    process.on('SIGINT', () => {
        console.log('\n\n❌ Download cancelled by user.');
        process.exit(0);
    });

    // 1. Prompt for .torrent file path with a safe validation loop
    while (true) {
        try {
            console.log(`\n📄 Default torrent file: ${defaultTorrentPath}`);
            const answer = await askUser('👉 Enter path to .torrent file (or press Enter for default): ');
            const torrentPath = answer.trim().length > 0 ? path.resolve(answer.trim()) : defaultTorrentPath;

            torrentMeta = parseTorrentFile(torrentPath);
            totalLength = torrentMeta.totalLength;
            break;
        } catch (err: any) {
            console.error(`\n❌ [Torrent Error]: Failed to load torrent file: ${err.message}`);
            console.log(`⚠️ Please check the file path and try again.`);
        }
    }

    printBanner(torrentMeta.name.toString());
    const peerId: Buffer = generatePeerId('PC', '0001');

    // 2. Prompt for download path and validate disk space / pre-allocation with a safe retry loop
    while (true) {
        try {
            console.log(`\n📂 Default download directory: ${defaultDownloadDir}`);
            const answer = await askUser('👉 Enter download folder path (or press Enter for default): ');
            const targetDir = answer.trim().length > 0 ? path.resolve(answer.trim()) : defaultDownloadDir;

            console.log(`\n🔍 Checking storage and pre-allocating space at: ${targetDir}...`);

            await fs.mkdir(targetDir, { recursive: true });
            const stats = await fs.statfs(targetDir);
            const availableBytes = stats.bavail * stats.bsize;

            console.log(`📦 Required Space: ${(totalLength / 1024 / 1024).toFixed(2)} MB`);
            console.log(`💾 Available Space: ${(availableBytes / 1024 / 1024).toFixed(2)} MB`);

            if (availableBytes < totalLength) {
                throw new Error(`Insufficient disk space! Required: ${(totalLength / 1024 / 1024).toFixed(2)} MB, Available: ${(availableBytes / 1024 / 1024).toFixed(2)} MB`);
            }

            break;
        } catch (err: any) {
            console.error(`\n❌ [Storage/Allocation Error]: ${err.message}`);
            console.log(`⚠️ Please provide a correct path with enough space for the file.`);
        }
    }

    const trackerParams: TrackerParams = {
        infoHash: torrentMeta.infoHash,
        peerId,
        port,
        uploaded: 0,
        downloaded: 0,
        left: totalLength,
        numwant: 200,
        event: 'started',
    };

    console.log('\n🌐 Contacting tracker...');
    const result = await urlDispatcher(torrentMeta.announceList, trackerParams);

    // --- Filter out self (127.0.0.1:4000) directly from the raw peers list ---
    // const peers = result.peers;
    peers = result.peers.filter((p: any) => !(p.ip === '127.0.0.1' && p.port === 4000));

    console.log(`👥 Peers discovered: ${peers.length} `);
    console.log(`⏱ Announce interval: ${result.peerStats.interval}\n`);

    const download = new DownloadManager({ peerList: peers, peerId, torrentMeta });

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

        // --- PROGRESS BAR RENDERER ---
        const barLength = 20;
        const numPercent = totalLength > 0 ? (download.session.completedBytes / totalLength) : 0;
        const filledLength = Math.round(barLength * numPercent);
        const bar = '█'.repeat(Math.max(0, filledLength)) + '░'.repeat(Math.max(0, barLength - filledLength));

        process.stdout.write(
            `\r\x1b[K📥 [${bar}] ${percent}% | Down: ${downloadedMB} / ${totalMB} MB | Speed: ${currentSpeedMBs.toFixed(2)} MB/s | Active Peers: ${lastActivePeers} | Failed: ${lastFailedPeers}`
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
            contacted: peers.length,
            success: session.activePeers || 1,
            failed: session.failedPeers,
            verified: true,
            downloaded: session.completedBytes,
            elapsedSeconds,
        });
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
