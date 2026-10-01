import EventEmitter from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { TorrentStorageConfig } from "./types.js";

export class TorrentStorage extends EventEmitter {
    public readonly totalSize: number;
    private readonly downloadPath: string;
    private fileHandle: fs.FileHandle | null = null;

    constructor({ totalSize, downloadPath }: TorrentStorageConfig) {
        super();
        this.totalSize = totalSize;
        this.downloadPath = downloadPath;
    }

    public async init(): Promise<void> {
        await fs.mkdir(path.dirname(this.downloadPath), { recursive: true });

        try {
            this.fileHandle = await fs.open(this.downloadPath, "r+");
        } catch (err: any) {
            if (err.code === "ENOENT") {
                this.fileHandle = await fs.open(this.downloadPath, "w+");
            } else {
                throw err;
            }
        }

        const stats = await this.fileHandle.stat();
        if (stats.size !== this.totalSize) {
            await this.fileHandle.truncate(this.totalSize);
        }
    }

    /**
     * Positional write loop ensuring 100% of buffer bytes are written.
     */
    public async write(offset: number, buffer: Buffer): Promise<void> {
        this.ensureReady();

        if (offset < 0 || offset + buffer.length > this.totalSize) {
            throw new Error(
                `Out of bounds write: [${offset}, ${offset + buffer.length}) exceeds total size ${this.totalSize}`
            );
        }

        let bytesWrittenTotal = 0;
        while (bytesWrittenTotal < buffer.length) {
            const { bytesWritten } = await this.fileHandle!.write(
                buffer,
                bytesWrittenTotal,                     // Buffer offset
                buffer.length - bytesWrittenTotal,     // Length remaining
                offset + bytesWrittenTotal            // File position
            );

            if (bytesWritten === 0) {
                throw new Error(`POSIX write stalled: 0 bytes written at offset ${offset + bytesWrittenTotal}`);
            }

            bytesWrittenTotal += bytesWritten;
        }
    }

    /**
     * Positional read loop ensuring complete fill of target length or EOF boundary.
     */
    public async readInto(
        targetBuffer: Buffer,
        targetOffset: number,
        length: number,
        fileOffset: number
    ): Promise<number> {
        this.ensureReady();

        if (fileOffset < 0 || fileOffset + length > this.totalSize) {
            throw new Error(
                `Out of bounds read: [${fileOffset}, ${fileOffset + length}) exceeds total size ${this.totalSize}`
            );
        }

        let bytesReadTotal = 0;
        while (bytesReadTotal < length) {
            const { bytesRead } = await this.fileHandle!.read(
                targetBuffer,
                targetOffset + bytesReadTotal,         // Target buffer offset
                length - bytesReadTotal,               // Length remaining
                fileOffset + bytesReadTotal           // File position
            );

            if (bytesRead === 0) {
                // Reached EOF unexpectedly before completing target length
                break;
            }

            bytesReadTotal += bytesRead;
        }

        return bytesReadTotal;
    }

    public async close(): Promise<void> {
        this.ensureReady();
        await this.fileHandle!.datasync();
        await this.fileHandle!.close();
        this.fileHandle = null;
    }

    private ensureReady(): void {
        if (!this.fileHandle) {
            throw new Error("Storage instance is not initialized. Call init() first.");
        }
    }
}
