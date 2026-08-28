import { EventEmitter } from "node:stream";
//import { computeSha1Hash } from '../identity/computeHash.js';
import { PieceManagerConfig, ActivePiece } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";

export class PieceManager extends EventEmitter {
    pieceLength: number;
    pieceHashes: Buffer[];
    totalLength: number;
    isMultiFile: boolean;
    pieceCount: number;
    lastPieceLength: number;

    totalDowloadedBytes: number;
    clientBitfield?: Buffer;

    private activePieces: Map<number, ActivePiece>

    constructor({
        pieceLength,
        pieceHashes,
        totalLength,
        isMultiFile,
        pieceCount
    }: PieceManagerConfig) {
        super();
        this.pieceHashes = pieceHashes;
        this.pieceLength = pieceLength;
        this.totalLength = totalLength;
        this.isMultiFile = isMultiFile;
        this.pieceCount = pieceCount;
        this.lastPieceLength = (totalLength % pieceLength) || pieceLength;

        //Initialize state
        this.activePieces = new Map();
        this.totalDowloadedBytes = 0;

        // A blank bitfield (1 bit per piece)
        const bitfieldSize = Math.ceil(pieceCount / 8);
        this.clientBitfield = Buffer.alloc(bitfieldSize, 0);
    }

    writeBlock(pieceIdx: number, begin: number, block: Buffer): void {
        // check piece availability to prevent duplication
        if (this.hasPiece(pieceIdx)) return;

        const pieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;

        // Initialize activePieces for this piece if new 
        if (!this.activePieces.has(pieceIdx)) {
            this.activePieces.set(pieceIdx, {
                buffer: Buffer.alloc(pieceSize),
                downloadedBytes: 0,
                receivedBlocks: new Set()
            });
        }

        // get the active data for this piece 
        const active = this.activePieces.get(pieceIdx);

        if (active === undefined) {
            throw ErrorFactory.active_piece(
                'INVALID_ACTIVE_PIECE',
                "pieceIndex associated with undefined activePieces object",
                { pieceIdx, active }
            );
        }

        // check again duplicate block
        if (active.receivedBlocks.has(begin)) return;

        // write the block to the piece buffer
        block.copy(active.buffer, begin);
        active.receivedBlocks.add(begin);
        active.downloadedBytes += block.length;
        this.totalDowloadedBytes += block.length;

        if (active.downloadedBytes === pieceSize) {
            this.verifyAndFlushPiece(pieceIdx, active.buffer);
        }
    }

    hasPiece(idx: number): boolean {
        const byteIdx = Math.floor(this.pieceCount / 8);
        const bitOffset = 7 - (idx % 8);
        if (this.clientBitfield === undefined) return false;
        return (this.clientBitfield[byteIdx] & (1 << bitOffset)) !== 0;
    };

    verifyAndFlushPiece(idx: number, buf: Buffer): void {
        
    };
}

