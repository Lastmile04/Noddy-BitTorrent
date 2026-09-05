import { EventEmitter } from "node:stream";
import { PieceManagerConfig, ActivePiece } from "./types.js";
import { ErrorFactory } from "../errors/TorrentError.js";
import { computeSha1Hash } from "../identity/computeHash.js";

const BLOCK_SIZE = 16384; // 16 KiB standard BitTorrent block size

export class PieceManager extends EventEmitter {
    pieceLength: number;
    pieceHashes: Buffer[];
    totalLength: number;
    isMultiFile: boolean;
    pieceCount: number;
    lastPieceLength: number;

    totalVerifiedBytes: number;
    clientBitfield: Buffer;

    private missingPieces: Set<number>;
    private activePieces: Map<number, ActivePiece>;

    constructor({
        pieceLength,
        pieceHashes,
        totalLength,
        isMultiFile,
        pieceCount,
        initialVerifiedPieces = [] // [] to prevent type error & for resumability
    }: PieceManagerConfig) {
        super();
        this.pieceHashes = pieceHashes;
        this.pieceLength = pieceLength;
        this.totalLength = totalLength;
        this.isMultiFile = isMultiFile;
        this.pieceCount = pieceCount;
        this.lastPieceLength = (totalLength % pieceLength) || pieceLength;

        this.activePieces = new Map();
        this.totalVerifiedBytes = 0;

        const bitfieldSize = Math.ceil(pieceCount / 8);
        this.clientBitfield = Buffer.alloc(bitfieldSize, 0);

        this.missingPieces = new Set(
            Array.from({ length: pieceCount }, (_, i) => i)
        );

        for (const idx of initialVerifiedPieces) {
            this.markPieceVerifiedLocally(idx);
        }
    }

    // QUERIES

    public acceptBlock(pieceIdx: number, begin: number, block: Buffer): void {
        if (pieceIdx < 0 || pieceIdx >= this.pieceCount) {
            throw ErrorFactory.piece_state('INVALID_PIECE_INDEX', "pieceIndex is out of bounds", { pieceIdx });
        }

        const pieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;

        // Boundary Check
        if (begin < 0 || begin >= pieceSize || (begin + block.length) > pieceSize) {
            throw ErrorFactory.piece_state('INVALID_BEGIN', 'BEGIN offset or length exceeds piece boundary', { begin, length: block.length });
        }

        // Overlap & Alignment Invariant
        if (begin % BLOCK_SIZE !== 0) {
            throw ErrorFactory.piece_state('UNALIGNED_BLOCK', 'Block offset is not aligned to 16 KiB boundary', { begin });
        }

        const expectedBlockLength = Math.min(BLOCK_SIZE, pieceSize - begin);
        if (block.length !== expectedBlockLength) {
            throw ErrorFactory.piece_state('INVALID_BLOCK_SIZE', 'Block length does not match standard 16 KiB or final remainder', { expected: expectedBlockLength, actual: block.length });
        }

        // Ignore blocks for pieces we have already verified locally 
        if (this.hasPiece(pieceIdx)) return;

        if (!this.activePieces.has(pieceIdx)) {
            this.activePieces.set(pieceIdx, {
                buffer: Buffer.alloc(pieceSize),
                downloadedBytes: 0,
                receivedBlocks: new Set()
            });
        }

        const active = this.activePieces.get(pieceIdx)!;

        // Prevent duplicate blocks (overlap is impossible due to alignment invariant)
        if (active.receivedBlocks.has(begin)) return;

        block.copy(active.buffer, begin);
        active.receivedBlocks.add(begin);
        active.downloadedBytes += block.length;

        if (active.downloadedBytes === pieceSize) {
            this.verifyPiece(pieceIdx, active.buffer, pieceSize);
        }
    }

    public findNeeded(): number[] {
        return Array.from(this.missingPieces);
    }

    public getMissingOffsets(pieceIdx: number): number[] {

        if (pieceIdx < 0 || pieceIdx >= this.pieceCount) {
            throw ErrorFactory.piece_state('INVALID_PIECE_INDEX', "pieceIndex is out of bounds", { pieceIdx });
        }

        if (this.hasPiece(pieceIdx)) return [];

        const pieceSize = pieceIdx === this.pieceCount - 1 ? this.lastPieceLength : this.pieceLength;
        const active = this.activePieces.get(pieceIdx);
        const missingOffset: number[] = [];

        for (let offset = 0; offset < pieceSize; offset += BLOCK_SIZE) {
            if (!active || !active.receivedBlocks.has(offset)) missingOffset.push(offset);
        }
        return missingOffset;
    }

    // HELPERS

    public hasPiece(idx: number): boolean {
        const byteIdx = Math.floor(idx / 8);
        const bitOffset = 7 - (idx % 8);
        return (this.clientBitfield[byteIdx] & (1 << bitOffset)) !== 0;
    }

    private markPieceVerifiedLocally(idx: number): void {

        if (idx < 0 || idx >= this.pieceCount) {
            throw ErrorFactory.piece_state('INVALID_PIECE_INDEX', "pieceIndex is out of bounds", { idx });
        }

        const byteIdx = Math.floor(idx / 8);
        const bitOffset = 7 - (idx % 8);
        this.clientBitfield[byteIdx] |= (1 << bitOffset);

        if (this.missingPieces.has(idx)) {
            this.missingPieces.delete(idx);
            this.totalVerifiedBytes += (idx === this.pieceCount - 1) ? this.lastPieceLength : this.pieceLength;
        }
    }


    private verifyPiece(idx: number, buf: Buffer, pieceSize: number): void {
        const bufHash = computeSha1Hash(buf);

        if (this.pieceHashes[idx].equals(bufHash)) {
            this.markPieceVerifiedLocally(idx);
            this.emit('piece_verified', { index: idx, buffer: buf });
        } else {
            // Notify scheduler that the piece failed so it can be re-queued
            this.emit('piece_verification_failed', { index: idx });
        }

        // State Transition: Clean up regardless of success or failure.
        this.activePieces.delete(idx);
    }
}
