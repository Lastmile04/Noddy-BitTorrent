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
    // private readonly MAX_OPEN_FILES = 200;
    private readonly pieceLength: number;

    private fileMap: Map<string, fs.FileHandle>;
    private isInitialized = false;
    private isClosed = false;

    constructor({ totalSize, rootDir, fileSpecs, pieceLength }: TorrentStorageConfig) {
        super();
        this.totalSize = totalSize;
        this.rootDir = rootDir;
        this.fileSpecs = fileSpecs;
        this.pieceLength = pieceLength;
        this.fileMap = new Map();
    }

    public async init(): Promise<void> {
        if (this.isInitialized) return;

        for (const file of this.fileSpecs) {
            const fullPath = path.join(this.rootDir, ...file.path);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            const handle = await fs.open(fullPath, "r+");
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

    public async writeInto(pieceIdx: number, pieceBuf: Buffer) {
        let globalOffset = pieceIdx * this.pieceLength;


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
}
