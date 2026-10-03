const KEYS = {
    ANNOUNCE: Buffer.from('announce'),
    ANNOUNCE_LIST: Buffer.from('announce-list'),
    INFO: Buffer.from('info'),
    META_VERSION: Buffer.from('meta version'), // BEP 0052 v2 flag

    // Info section keys
    NAME: Buffer.from('name'),
    PIECES: Buffer.from('pieces'),         // v1 SHA-1 hashes (concat 20-byte chunks)
    PIECE_LENGTH: Buffer.from('piece length'),
    LENGTH: Buffer.from('length'),         // v1 single-file length
    FILES: Buffer.from('files'),           // v1 multi-file list
    PATH: Buffer.from('path'),             // v1 file path list
    FILE_TREE: Buffer.from('file tree'),   // v2 file tree

    // File tree leaf key
    PIECES_ROOT: Buffer.from('pieces root') // v2 SHA-256 Merkle root
};

/**
 * Extracts and validates metadata from a bdecoded torrent dictionary.
 * Supports trackless (DHT/PEX) torrents safely.
 */
export function torrentMetadataExtraction(decodedNode) {
    if (!decodedNode || decodedNode.type !== 'DICT') {
        throw new Error('Invalid Torrent: Expected Dictionary at root');
    }

    let announceListNode = null;
    let announceNode = null;
    let infoSectionNode = null;

    for (const [keyNode, valueNode] of decodedNode.value) {
        if (keyNode.type !== 'BYTE_STRING') {
            throw new Error('Invalid Torrent: Dictionary keys must be byte strings');
        }

        const keyBuf = keyNode.value;

        if (keyBuf.equals(KEYS.INFO)) {
            if (valueNode.type !== 'DICT') {
                throw new Error('Invalid Torrent: "info" value must be a dictionary');
            }
            infoSectionNode = valueNode;
        } else if (keyBuf.equals(KEYS.ANNOUNCE_LIST)) {
            if (valueNode.type === 'LIST') announceListNode = valueNode;
        } else if (keyBuf.equals(KEYS.ANNOUNCE)) {
            if (valueNode.type === 'BYTE_STRING') announceNode = valueNode;
        }
    }

    if (!infoSectionNode) {
        throw new Error('Invalid Torrent: Missing required "info" dictionary');
    }

    // Announce keys are optional in trackless / DHT torrents
    const primaryAnnounce = announceListNode || announceNode;
    const announceList = primaryAnnounce ? extractTiers(primaryAnnounce) : [];
    const infoMetadata = extractInfoMeta(infoSectionNode);

    return {
        announceList,
        ...infoMetadata
    };
}

/**
 * Extracts file layout and piece verification metadata from the info dictionary.
 */
export function extractInfoMeta(infoNode) {
    let name = null;
    let pieceLength = null;
    let pieceHashes = null;
    let multiFileNode = null;
    let singleFileNode = null;

    for (const [keyNode, valueNode] of infoNode.value) {
        if (keyNode.type !== 'BYTE_STRING') {
            throw new Error('Invalid Torrent: "info" dictionary keys must be byte strings');
        }

        const keyBuf = keyNode.value;

        if (keyBuf.equals(KEYS.PIECES)) {
            if (valueNode.type !== 'BYTE_STRING') {
                throw new Error('Invalid Torrent: "pieces" must be a byte string');
            }
            pieceHashes = valueNode.value;
        } else if (keyBuf.equals(KEYS.PIECE_LENGTH)) {
            if (valueNode.type !== 'INTEGER') {
                throw new Error('Invalid Torrent: "piece length" must be an integer');
            }
            pieceLength = valueNode.value;
        } else if (keyBuf.equals(KEYS.NAME)) {
            if (valueNode.type !== 'BYTE_STRING') {
                throw new Error('Invalid Torrent: "name" must be a byte string');
            }
            name = valueNode.value.toString('utf-8');
        } else if (keyBuf.equals(KEYS.FILES)) {
            multiFileNode = valueNode;
        } else if (keyBuf.equals(KEYS.LENGTH)) {
            singleFileNode = valueNode;
        }
    }

    // --- Structural Validation Guards ---
    if (!name || name.trim() === '') {
        throw new Error('Invalid Torrent: Missing or empty "name"');
    }
    if (!Number.isInteger(pieceLength) || pieceLength <= 0) {
        throw new Error('Invalid Torrent: "piece length" must be a positive integer');
    }
    if (!pieceHashes || pieceHashes.length === 0 || pieceHashes.length % 20 !== 0) {
        throw new Error('Invalid Torrent: "pieces" hash buffer must be non-empty and a multiple of 20 bytes');
    }
    if (multiFileNode && singleFileNode) {
        throw new Error('Invalid Torrent: "info" section cannot contain both "length" and "files"');
    }
    if (!multiFileNode && !singleFileNode) {
        throw new Error('Invalid Torrent: "info" section must contain either "length" or "files"');
    }

    const files = [];
    let totalLength = 0;

    if (multiFileNode) {
        if (multiFileNode.type !== 'LIST' || multiFileNode.value.length === 0) {
            throw new Error('Invalid Torrent: "files" must be a non-empty List');
        }

        for (const fileNode of multiFileNode.value) {
            if (fileNode.type !== 'DICT') {
                throw new Error('Invalid Torrent: File entry must be a dictionary');
            }

            let fileLength = null;
            let filePath = null;

            for (const [fileKeyNode, fileNodeVal] of fileNode.value) {
                if (fileKeyNode.type !== 'BYTE_STRING') continue;

                if (fileKeyNode.value.equals(KEYS.LENGTH)) {
                    if (fileNodeVal.type !== 'INTEGER' || fileNodeVal.value < 0) {
                        throw new Error('Invalid Torrent: File length must be a non-negative integer');
                    }
                    fileLength = fileNodeVal.value;
                } else if (fileKeyNode.value.equals(KEYS.PATH)) {
                    if (fileNodeVal.type !== 'LIST' || fileNodeVal.value.length === 0) {
                        throw new Error('Invalid Torrent: File path must be a non-empty list');
                    }
                    filePath = fileNodeVal.value.map((p) => {
                        if (p.type !== 'BYTE_STRING') {
                            throw new Error('Invalid Torrent: Path segment must be a byte string');
                        }
                        return p.value.toString('utf-8');
                    });
                }
            }

            if (fileLength === null || !filePath) {
                throw new Error('Invalid Torrent: File entry missing "length" or "path"');
            }

            const startOffset = totalLength;
            totalLength += fileLength;

            // Pre-pend torrent root name directory to multi-file relative path segments
            files.push({
                path: [name, ...filePath],
                length: fileLength,
                startOffset,
                endOffset: totalLength
            });
        }
    } else {
        if (singleFileNode.type !== 'INTEGER' || singleFileNode.value < 0) {
            throw new Error('Invalid Torrent: "length" must be a non-negative integer');
        }
        totalLength = singleFileNode.value;
        files.push({
            path: [name],
            length: totalLength,
            startOffset: 0,
            endOffset: totalLength
        });
    }

    // --- v1 Validation Guards ---
    const pieceCount = pieceHashes.length / 20;
    const expectedPieceCount = totalLength === 0 ? 0 : Math.ceil(totalLength / pieceLength);

    if (pieceCount !== expectedPieceCount) {
        throw new Error(
            `Torrent Mismatch: Piece count in hashes (${pieceCount}) does not match expected count (${expectedPieceCount}) derived from total length (${totalLength} bytes)`
        );
    }

    const lastPieceLength = totalLength === 0
        ? 0
        : (totalLength % pieceLength === 0 ? pieceLength : totalLength % pieceLength);

    return {
        name,
        pieceLength,
        lastPieceLength,
        pieceHashes: splitPieceHashes(pieceHashes),
        pieceCount,
        totalLength,
        isMultiFile: Boolean(multiFileNode),
        files
    };
}

/**
 * Splits continuous SHA-1 buffer into 20-byte Buffer chunks.
 */
function splitPieceHashes(buf) {
    const piecesArr = [];
    for (let offset = 0; offset < buf.length; offset += 20) {
        piecesArr.push(buf.subarray(offset, offset + 20));
    }
    return piecesArr;
}

/**
 * Parses announce tiers into a 2D array of tracker URLs.
 */
export function extractTiers(announceNode) {
    if (!announceNode) return [];

    const res = [];
    const { value, type } = announceNode;

    if (type === 'BYTE_STRING') {
        res.push([value.toString('utf-8')]);
        return res;
    }

    if (type === 'LIST') {
        for (const tier of value) {
            if (tier.type === 'LIST') {
                const trackerList = [];
                for (const tracker of tier.value) {
                    if (tracker.type === 'BYTE_STRING') {
                        trackerList.push(tracker.value.toString('utf-8'));
                    }
                }
                if (trackerList.length > 0) res.push(trackerList);
            }
        }
    }

    return res;
}
