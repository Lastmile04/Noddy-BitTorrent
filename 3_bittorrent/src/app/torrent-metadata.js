const KEYS = {
    // main function keys
    ANNOUNCE: Buffer.from('announce'),
    ANNOUNCE_LIST: Buffer.from('announce-list'),
    INFO: Buffer.from('info'),

    // info section keys
    NAME: Buffer.from('name'),
    PIECES: Buffer.from('pieces'),
    PIECE_LENGTH: Buffer.from('piece length'),
    LENGTH: Buffer.from('length'),
    FILES: Buffer.from('files'),
    PATH: Buffer.from('path')
};

export function torrentMetadataExtraction(decodedNode) {
    if (decodedNode.type !== 'DICT') throw new Error('Expected Dictionary at root');

    const pairs = decodedNode.value;
    let announceListNode = null,
        announceNode = null,
        infoSectionNode = null,
        infoSectionPresent = false;

    for (const [keyNode, valueNode] of pairs) {
        if (keyNode.type !== 'BYTE_STRING') throw new Error("The keys of dict pair must be a byte string");
        const keyBuf = keyNode.value;

        if (keyBuf.equals(KEYS.INFO)) {
            infoSectionPresent = true;
            if (valueNode.type !== "DICT") throw new Error('infoSection value must be a dictionary');
            infoSectionNode = valueNode;
        } else if (keyBuf.equals(KEYS.ANNOUNCE_LIST)) {
            if (valueNode.type !== 'LIST') throw new Error('announce-list value must be a List');
            announceListNode = valueNode;
        } else if (keyBuf.equals(KEYS.ANNOUNCE)) {
            if (valueNode.type !== 'BYTE_STRING') throw new Error('announce value must be string');
            announceNode = valueNode;
        }
    }

    if (!infoSectionPresent || !infoSectionNode) {
        throw new Error('infoSection is not present in the .torrent file');
    }

    const primaryAnnounce = announceListNode || announceNode;
    if (!primaryAnnounce) {
        throw new Error('No tracker information found (missing announce and announce-list)');
    }

    const tiers = extractTiers(primaryAnnounce);
    const infoMetadata = extractInfoMeta(infoSectionNode);
    console.log("TIERS:", tiers);

    return {
        announceList: tiers,
        ...infoMetadata
    };
}

export function extractTiers(announceNode) {
    const res = [];
    const { value, type } = announceNode;

    // Single string fallback ('announce')
    if (type === 'BYTE_STRING') {
        res.push([value.toString('utf-8')]);
        return res;
    }

    // Multi-tier tracker list ('announce-list')
    for (const tier of value) {
        const trackerList = [];
        if (tier.type !== 'LIST') throw new Error("Tier must be a list");

        for (const tracker of tier.value) {
            if (tracker.type !== 'BYTE_STRING') throw new Error("Trackers must be strings");
            trackerList.push(tracker.value.toString('utf-8'));
        }

        if (trackerList.length > 0) res.push(trackerList);
    }

    return res;
}

export function extractInfoMeta(infoNode) {
    let name,
        pieceLength,
        lastPieceLength,
        pieceHashes,
        pieceCount,
        totalLength = 0,
        multiFileNode,
        singleFileNode;

    for (const [keyNode, valueNode] of infoNode.value) {
        if (keyNode.type !== 'BYTE_STRING') throw new Error('infoSection keys must be byte strings');
        const keyBuf = keyNode.value;

        if (keyBuf.equals(KEYS.PIECES)) {
            if (valueNode.type !== 'BYTE_STRING') throw new Error('pieces must be a byte string');
            pieceHashes = valueNode.value;
        } else if (keyBuf.equals(KEYS.PIECE_LENGTH)) {
            if (valueNode.type !== 'INTEGER') throw new Error('piece length must be an integer');
            pieceLength = valueNode.value;
        } else if (keyBuf.equals(KEYS.NAME)) {
            if (valueNode.type !== 'BYTE_STRING') throw new Error('name must be a byte string');
            name = valueNode.value.toString("utf-8");
        } else if (keyBuf.equals(KEYS.FILES)) {
            multiFileNode = valueNode; // Store Node reference
        } else if (keyBuf.equals(KEYS.LENGTH)) {
            singleFileNode = valueNode; // Store Node reference
        }
    }

    if (
        (!singleFileNode && !multiFileNode) ||
        (!name) ||
        (!Number.isInteger(pieceLength) || pieceLength <= 0) ||
        (!pieceHashes)
    ) {
        throw new Error('Invalid Torrent: Missing required info metadata');
    }

    if (multiFileNode) {
        if (multiFileNode.type !== 'LIST') throw new Error('files must be a List');

        for (const fileNode of multiFileNode.value) {
            if (fileNode.type !== 'DICT') throw new Error('file entry must be a Dictionary');

            for (const [fileKeyNode, fileValNode] of fileNode.value) {
                if (fileKeyNode.type !== 'BYTE_STRING') throw new Error("file key must be a byte string");

                if (fileKeyNode.value.equals(KEYS.LENGTH)) {
                    if (fileValNode.type !== 'INTEGER') throw new Error('file length must be an Integer');
                    const val = fileValNode.value;

                    if (Number.isInteger(val) && val >= 0) {
                        totalLength += val;
                    } else {
                        throw new Error('Malformed Torrent: Invalid negative file length');
                    }
                }
            }
        }
    } else {
        if (singleFileNode.type !== 'INTEGER') throw new Error('length value must be an Integer');
        totalLength = singleFileNode.value;
    }

    if (pieceHashes.length === 0 || pieceHashes.length % 20 !== 0) {
        throw new Error('Invalid piece Hash length: Must be non-zero multiple of 20');
    }

    pieceCount = pieceHashes.length / 20;
    const splitHashes = splitPieceHashes(pieceHashes);

    lastPieceLength = (totalLength % pieceLength === 0) ? pieceLength : (totalLength % pieceLength);

    return {
        name,
        pieceLength,
        lastPieceLength,
        pieceHashes: splitHashes,
        pieceCount,
        totalLength,
        isMultiFile: Boolean(multiFileNode)
    };
}

function splitPieceHashes(buf) {
    const piecesArr = [];
    for (let offset = 0; offset < buf.length; offset += 20) {
        piecesArr.push(buf.subarray(offset, offset + 20));
    }
    return piecesArr;
}
