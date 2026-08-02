import fs from 'fs';
// import { validateBencode } from '../codec/validator.js';
import { getInfoSection } from '../identity/InfoByte.js';
import { computeSha1Hash } from '../identity/computeHash.js';
import { decode } from '../codec/parser.ts';
import { torrentMetadataExtraction } from './torrent-metadata.js';

export function parseTorrentFile(torrentPath) {
    try {
        // Read torrent file
        const buffer = fs.readFileSync(torrentPath);

        // Validate bencode structure
        // validateBencode(buffer);
        // console.log('📦 Torrent metadata validated');

        // Extract info section
        const infoSection = getInfoSection(buffer);
        // console.log('Info section extracted');
        // console.log('Start offset->', infoSection.start);
        // console.log('End offset->', infoSection.end);

        // Compute info hash
        const infoHash = computeSha1Hash(infoSection.raw);
        console.log('🔑 Info hash generated (hex)->', infoHash.toString('hex'));

        const decoded = decode(buffer, 0);

        const torrentMetadata = torrentMetadataExtraction(decoded);
        // const torrentAnnounceList = [['udp://tracker.opentrackr.org:1337', 'udp://tracker.openbittorrent.com:6969', 'udp://open.stealth.si:80']]

        // Return important values
        return {
            // buffer,           // Full torrent file buffer
            ...torrentMetadata,
            infoHash,         // Buffer (20 bytes) 
        };

    } catch (error) {
        console.error('❌ Failed to parse torrent:', error.message);
        throw error; // Re-throw so caller can handle
    }
}

