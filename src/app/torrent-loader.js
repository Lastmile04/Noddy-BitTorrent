import fs from 'fs';
import { getInfoSection } from '../identity/InfoByte.js';
import { computeSha1Hash } from '../identity/computeHash.js';
import { decode } from '../codec/parser.ts';
import { torrentMetadataExtraction } from './torrent-metadata.js';

export function parseTorrentFile(torrentPath) {
    try {
        // Read torrent file
        const buffer = fs.readFileSync(torrentPath);


        // Extract info section
        const infoSection = getInfoSection(buffer);

        // Compute info hash
        const infoHash = computeSha1Hash(infoSection.raw);
        const decoded = decode(buffer, 0);
        const torrentMetadata = torrentMetadataExtraction(decoded);

        // Return important values
        return {
            // buffer,           // Full torrent file buffer
            ...torrentMetadata,
            infoHash,         // Buffer (20 bytes) 
        };

    } catch (error) {
        throw error; // Re-throw so caller can handle
    }
}
