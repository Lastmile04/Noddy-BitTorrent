import EventEmitter from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { TorrentStorageConfig } from "./types.js";
import { TorrentFileSpec } from "../app/types.js";

interface FileSlice {
    fullPath: string;
    fileOffset: number;
    bytesToProcess: number;
}

export class TorrentStorage extends EventEmitter {
    public readonly totalSize: number;
    private readonly rootDir: string;
    private readonly fileSpecs: TorrentFileSpec[];
    private readonly MAX_OPEN_FILES = 200;

    private fileMap: Map<string, fs.FileHandle>;
    private isInitialized = false;
    private isClosed = false;

    constructor({ totalSize, rootDir, fileSpecs }: TorrentStorageConfig) {
        super();
        this.totalSize = totalSize;
        this.rootDir = rootDir;
        this.fileSpecs = fileSpecs;
        this.fileMap = new Map();
    }

    public async init(): Promise<void> {
        if (this.isInitialized) return;

        for (const file of this.fileSpecs) {
            const fullPath = path.join(this.rootDir, ...file.path);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            // Ensure file exists and is pre-allocated
            const handle = await fs.open(fullPath, "a+");
            try {
                const stats = await handle.stat();
                if (stats.size !== file.length) {
                    await handle.truncate(file.length);
                }
            } finally {
                // Close immediately after pre-allocation. Do NOT store in fileMap.
                await handle.close();
            }
        }

        this.isInitialized = true;
    }

    private async getHandle(fullPath: string): Promise<fs.FileHandle> {
        // 1. Cache hit: Move key to end to maintain LRU access order
        let handle = this.fileMap.get(fullPath);
        if (handle) {
            this.fileMap.delete(fullPath);
            this.fileMap.set(fullPath, handle);
            return handle;
        }

        // 2. Cache miss + full capacity: Evict least recently used handle
        if (this.fileMap.size >= this.MAX_OPEN_FILES) {
            const oldestKey = this.fileMap.keys().next().value;
            if (oldestKey) {
                const oldestHandle = this.fileMap.get(oldestKey);
                if (oldestHandle) {
                    await oldestHandle.datasync();
                    await oldestHandle.close();
                }
                this.fileMap.delete(oldestKey);
            }
        }

        // 3. Open handle on-demand for reading/writing
        handle = await fs.open(fullPath, "r+");
        this.fileMap.set(fullPath, handle);
        return handle;
    }

    /**
     * Maps a global torrent byte range [globalOffset, globalOffset + length)
     * into target files and their relative local offsets.
     */
    private getFileSlices(globalOffset: number, length: number): FileSlice[] {
        const slices: FileSlice[] = [];
        let currentGlobal = globalOffset;
        let bytesRemaining = length;
        let fileStart = 0;

        for (const file of this.fileSpecs) {
            const fileEnd = fileStart + file.length;

            // Check if global offset range intersects this file
            if (currentGlobal < fileEnd && currentGlobal + bytesRemaining > fileStart) {
                const startInFile = Math.max(0, currentGlobal - fileStart);
                const bytesInFile = Math.min(file.length - startInFile, bytesRemaining);
                const fullPath = path.join(this.rootDir, ...file.path);

                slices.push({
                    fullPath,
                    fileOffset: startInFile,
                    bytesToProcess: bytesInFile,
                });

                currentGlobal += bytesInFile;
                bytesRemaining -= bytesInFile;

                if (bytesRemaining <= 0) break;
            }

            fileStart = fileEnd;
        }

        return slices;
    }

    public async write(globalOffset: number, buffer: Buffer): Promise<void> {
        this.ensureReady();

        if (globalOffset < 0 || globalOffset + buffer.length > this.totalSize) {
            throw new Error(
                `Out of bounds write: [${globalOffset}, ${globalOffset + buffer.length}) exceeds total size ${this.totalSize}`
            );
        }

        const slices = this.getFileSlices(globalOffset, buffer.length);
        let bufferOffset = 0;

        for (const slice of slices) {
            const handle = await this.getHandle(slice.fullPath);
            let bytesWrittenForSlice = 0;

            while (bytesWrittenForSlice < slice.bytesToProcess) {
                const { bytesWritten } = await handle.write(
                    buffer,
                    bufferOffset + bytesWrittenForSlice,
                    slice.bytesToProcess - bytesWrittenForSlice,
                    slice.fileOffset + bytesWrittenForSlice
                );

                if (bytesWritten === 0) {
                    throw new Error(`POSIX write stalled at ${slice.fullPath} offset ${slice.fileOffset + bytesWrittenForSlice}`);
                }

                bytesWrittenForSlice += bytesWritten;
            }

            bufferOffset += slice.bytesToProcess;
        }
    }

    public async readInto(
        targetBuffer: Buffer,
        targetOffset: number,
        length: number,
        globalOffset: number
    ): Promise<number> {
        this.ensureReady();

        if (globalOffset < 0 || globalOffset + length > this.totalSize) {
            throw new Error(
                `Out of bounds read: [${globalOffset}, ${globalOffset + length}) exceeds total size ${this.totalSize}`
            );
        }

        const slices = this.getFileSlices(globalOffset, length);
        let totalBytesRead = 0;

        for (const slice of slices) {
            const handle = await this.getHandle(slice.fullPath);
            let bytesReadForSlice = 0;

            while (bytesReadForSlice < slice.bytesToProcess) {
                const { bytesRead } = await handle.read(
                    targetBuffer,
                    targetOffset + totalBytesRead + bytesReadForSlice,
                    slice.bytesToProcess - bytesReadForSlice,
                    slice.fileOffset + bytesReadForSlice
                );

                if (bytesRead === 0) {
                    break; // Reached EOF unexpectedly
                }

                bytesReadForSlice += bytesRead;
            }

            totalBytesRead += bytesReadForSlice;
            if (bytesReadForSlice < slice.bytesToProcess) {
                break; // Stop if a file end was reached prematurely
            }
        }

        return totalBytesRead;
    }

    public async close(): Promise<void> {
        if (!this.isInitialized || this.isClosed) return;

        for (const handle of this.fileMap.values()) {
            await handle.datasync();
            await handle.close();
        }

        this.fileMap.clear();
        this.isClosed = true;
    }

    private ensureReady(): void {
        if (!this.isInitialized) {
            throw new Error("Storage instance is not initialized. Call init() first.");
        }
        if (this.isClosed) {
            throw new Error("Storage instance has been closed.");
        }
    }
}
