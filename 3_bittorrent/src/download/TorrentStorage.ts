import EventEmitter from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { TorrentStorageConfig, FileSlice } from "./types.js";
import { TorrentFileSpec } from "../app/types.js";
import { stat } from "node:fs";

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
        if (!this.isInitialized) return;

        for (const file of this.fileSpecs) {
            const fullPath = path.join(this.rootDir, ...file.path);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            const handle = await fs.open(fullPath, "a+");
            try {
                const stats = await handle.stat();
                if (stats.size !== file.length) {
                    await handle.truncate(file.length);
                }
            } finally {
                await handle.close();
            }
        }

        this.isInitialized = true;
    }

    private fileMapper(globalOffset: number, length: number): FileSlice[] {
        const slices: FileSlice[] = [];
        let currentGlobal = globalOffset;
        let bytesRemaining = length;

        for (const file of this.fileSpecs) {
            // determine if piece is mappable to current file range 
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
        return slices;
    }

    private async getHandle(fullPath: string): Promise<fs.FileHandle> {
        let handle = this.fileMap.get(fullPath);
        // maintain LRU access order
        if (handle) {
            this.fileMap.delete(fullPath);
            this.fileMap.set(fullPath, handle);
            return handle;
        }

        if (this.fileMap.size >= this.MAX_OPEN_FILES) {
            // use js insertion order to figure out the last key arranged becasue of LRU order
            const oldestKey = this.fileMap.keys().next().value;
            if (oldestKey) {
                const oldestHandle = this.fileMap.get(oldestKey);
                if (oldestHandle) {
                    await oldestHandle?.datasync();
                    await oldestHandle?.close();
                }
            }
            this.fileMap.delete(oldestKey!);
        }

        handle = await fs.open(fullPath, "r+");
        this.fileMap.set(fullPath, handle);
        return handle;
    }
}
