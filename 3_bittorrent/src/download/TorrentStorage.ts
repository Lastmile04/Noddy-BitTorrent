import EventEmitter from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { TorrentStorageConfig, FileSlice } from "./types.js";
import { TorrentFileSpec } from "../app/types.js";
import { ErrorFactory } from "../errors/TorrentError.js";

export class TorrentStorage extends EventEmitter {
    public readonly totalSize: number;
    private readonly rootDir: string;
    private readonly fileSpecs: TorrentFileSpec[];
    private readonly pieceLength: number;

    private readonly fileMap: Map<string, Promise<fs.FileHandle>> = new Map();
    private readonly activeOps: Set<Promise<unknown>> = new Set();

    private isInitialized = false;
    private isClosed = false;

    constructor({
        totalSize,
        rootDir,
        fileSpecs,
        pieceLength,
    }: TorrentStorageConfig) {
        super();
        this.totalSize = totalSize;
        this.rootDir = rootDir;
        this.fileSpecs = fileSpecs;
        this.pieceLength = pieceLength;
    }

    public async init(): Promise<void> {
        if (this.isInitialized) return;
        if (this.isClosed) {
            throw ErrorFactory.storage("STORAGE_CLOSED", "Cannot initialize a closed storage instance");
        }

        try {
            for (const file of this.fileSpecs) {
                const fullPath = path.join(this.rootDir, ...file.path);
                await fs.mkdir(path.dirname(fullPath), { recursive: true });

                const handle = await fs.open(fullPath, "a+");
                try {
                    const stats = await handle.stat();
                    if (stats.size < file.length) {
                        await handle.truncate(file.length);
                    }
                } finally {
                    await handle.close();
                }
            }
            this.isInitialized = true;
        } catch (err) {
            throw ErrorFactory.fromStorageError(err, { operation: "init", rootDir: this.rootDir });
        }
    }

    /**
     * Writes a piece buffer directly across one or more mapped file ranges.
     */
    public async writeInto(pieceIdx: number, pieceBuf: Buffer): Promise<void> {
        return this.executeIO(async () => {
            const globalOffset = pieceIdx * this.pieceLength;
            if (globalOffset + pieceBuf.length > this.totalSize) {
                throw ErrorFactory.storage("OUT_OF_BOUNDS", "Write offset extends past total torrent boundary", {
                    pieceIdx,
                    pieceLength: pieceBuf.length,
                    totalSize: this.totalSize,
                });
            }

            const rangeSlices = this.resolveFileRanges(globalOffset, pieceBuf.length);
            let bufferOffset = 0;

            for (const slice of rangeSlices) {
                const handle = await this.getHandle(slice.fullPath);
                await handle.write(pieceBuf, bufferOffset, slice.bytesToProcess, slice.fileOffset);
                bufferOffset += slice.bytesToProcess;
            }
        });
    }

    /**
     * Reads a piece or block back from the mapped storage files.
     */
    public async readFrom(pieceIdx: number, length: number, blockOffsetWithinPiece = 0): Promise<Buffer> {
        return this.executeIO(async () => {
            const globalOffset = pieceIdx * this.pieceLength + blockOffsetWithinPiece;
            if (globalOffset + length > this.totalSize) {
                throw ErrorFactory.storage("OUT_OF_BOUNDS", "Read offset extends past total torrent boundary", {
                    pieceIdx,
                    blockOffsetWithinPiece,
                    length,
                    totalSize: this.totalSize,
                });
            }

            const rangeSlices = this.resolveFileRanges(globalOffset, length);
            const resultBuf = Buffer.alloc(length);
            let bufferOffset = 0;

            for (const slice of rangeSlices) {
                const handle = await this.getHandle(slice.fullPath);
                const { bytesRead } = await handle.read(
                    resultBuf,
                    bufferOffset,
                    slice.bytesToProcess,
                    slice.fileOffset
                );

                if (bytesRead < slice.bytesToProcess) {
                    throw ErrorFactory.storage(
                        "READ_FAILED",
                        `Incomplete disk read: expected ${slice.bytesToProcess} bytes, got ${bytesRead}`,
                        { fullPath: slice.fullPath, fileOffset: slice.fileOffset }
                    );
                }
                bufferOffset += slice.bytesToProcess;
            }

            return resultBuf;
        });
    }

    /**
     * Gracefully waits for in-flight I/O tasks to settle before closing file handles.
     */
    public async close(): Promise<void> {
        if (this.isClosed) return;
        this.isClosed = true; // Gate new writeInto / readFrom requests

        // Wait for all in-flight I/O operations to finish
        if (this.activeOps.size > 0) {
            await Promise.allSettled(Array.from(this.activeOps));
        }

        // Collect handle promises (including any lazy open promises that finished during drain)
        const handlePromises = Array.from(this.fileMap.values());
        this.fileMap.clear();

        const handles = await Promise.all(handlePromises.map((p) => p.catch(() => null)));

        // Close all open descriptors safely
        await Promise.all(
            handles.map((handle) => handle?.close().catch(() => { }))
        );
    }

    /**
      Wraps active storage operations in the tracking set.
     */
    private async executeIO<T>(operation: () => Promise<T>): Promise<T> {
        this.ensureActiveState();

        const ioPromise = operation();
        this.activeOps.add(ioPromise);

        try {
            return await ioPromise;
        } finally {
            this.activeOps.delete(ioPromise);
        }
    }

    private getHandle(fullPath: string): Promise<fs.FileHandle> {
        let handlePromise = this.fileMap.get(fullPath);
        if (!handlePromise) {
            handlePromise = fs.open(fullPath, "r+").catch((err) => {
                this.fileMap.delete(fullPath);
                throw err;
            });
            this.fileMap.set(fullPath, handlePromise);
        }
        return handlePromise;
    }

    private resolveFileRanges(globalOffset: number, length: number): FileSlice[] {
        const slices: FileSlice[] = [];
        let currentGlobal = globalOffset;
        let bytesRemaining = length;

        for (const file of this.fileSpecs) {
            if (currentGlobal >= file.startOffset && currentGlobal < file.endOffset) {
                const fullPath = path.join(this.rootDir, ...file.path);
                const fileOffset = Math.max(0, currentGlobal - file.startOffset);
                const bytesToProcess = Math.min(bytesRemaining, file.endOffset - currentGlobal);

                slices.push({ fullPath, fileOffset, bytesToProcess });

                bytesRemaining -= bytesToProcess;
                currentGlobal += bytesToProcess;

                if (bytesRemaining <= 0) break;
            }
        }

        // Defensive check: verify total resolved slices cover the entire requested range
        if (bytesRemaining > 0) {
            throw ErrorFactory.storage(
                "OUT_OF_BOUNDS",
                `Offset range [${globalOffset}, ${globalOffset + length}) could not be fully mapped to file specs`
            );
        }

        return slices;
    }

    private ensureActiveState(): void {
        if (!this.isInitialized) {
            throw ErrorFactory.storage("STORAGE_NOT_INITIALIZED", "Storage must be initialized before performing I/O");
        }
        if (this.isClosed) {
            throw ErrorFactory.storage("STORAGE_CLOSED", "Cannot perform I/O operations on closed storage");
        }
    }
}
