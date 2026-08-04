import { EventEmitter } from "node:stream";
import { computeSha1Hash } from '../identity/computeHash.js';
import { PieceManagerConfig } from "./types.js";

export class PieceManager extends EventEmitter {
    constructor({
        pieceLength,
        pieceHashes,
        totalLength,
        isMultiFile,
        pieceCount
    }: PieceManagerConfig) {
        super();
        this.pieceHashes = torrentMeta.pieceHashes;
        this.targetPieceIdx = null;
        this.downloadedBytes = 0;
        this.pieceBuffer = null;

    }


    findNeeded() {
        // NOTE: For MVP's sake we'll return as soon as we have a valid pieceCount instead of collecting all the valid pieceCounts in peer Bitfield
        for (let byteIdx = 0; byteIdx < this.peerBitfield.length; byteIdx++) {
            const peerByte = this.peerBitfield[byteIdx];
            const myByte = this.bitfield ? this.bitfield[byteIdx] : 0;
            // Since Bits are form 7->0
            for (let bit = 7; bit >= 0; bit--) {
                const pieceIndex = byteIdx * 8 + (7 - bit);
                if (pieceIndex >= this.pieceCount) break;

                // check the piece using bit mask
                const peerHas = (peerByte >> bit) & 1;
                const iHave = (myByte >> bit) & 1;
                if (peerHas && !iHave) return pieceIndex;
            }
        }
        return null;
    }

    verifyPieceHash() {
        const idx = this.targetPieceIdx;
        const pieceHash = computeSha1Hash(this.pieceBuffer);

        return this.pieceHashes[idx].equals(pieceHash);
    }
}
