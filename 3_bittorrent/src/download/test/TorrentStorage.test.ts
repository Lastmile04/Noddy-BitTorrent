import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Buffer } from "node:buffer";
import { TorrentStorage } from "../TorrentStorage.js";
import { TorrentFileSpec } from "../../app/types.js";

// Mock node:fs/promises to allow spying on ESM exports in Vitest
vi.mock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return {
        ...actual,
        open: vi.fn(actual.open),
    };
});

describe("TorrentStorage Unit Tests", () => {
    let tmpDir: string;

    beforeEach(async () => {
        // Create an isolated temporary directory for each test run
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-storage-test-"));
    });

    afterEach(async () => {
        // Clean up temporary disk files
        await fs.rm(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    // Helper to generate test file specs
    function createMultiFileSpecs(): { fileSpecs: TorrentFileSpec[]; totalSize: number; pieceLength: number } {
        const fileSpecs: TorrentFileSpec[] = [
            {
                path: ["folder", "file1.bin"],
                length: 600,
                startOffset: 0,
                endOffset: 600,
            },
            {
                path: ["folder", "file2.bin"],
                length: 400,
                startOffset: 600,
                endOffset: 1000,
            },
        ];

        return {
            fileSpecs,
            totalSize: 1000,
            pieceLength: 400,
        };
    }

    describe("Initialization & Pre-allocation", () => {
        it("creates nested directories and truncates files to expected size on init()", async () => {
            const { fileSpecs, totalSize, pieceLength } = createMultiFileSpecs();
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize,
                fileSpecs,
                pieceLength,
            });

            await storage.init();

            const file1Path = path.join(tmpDir, "folder", "file1.bin");
            const file2Path = path.join(tmpDir, "folder", "file2.bin");

            const stat1 = await fs.stat(file1Path);
            const stat2 = await fs.stat(file2Path);

            expect(stat1.size).toBe(600);
            expect(stat2.size).toBe(400);

            await storage.close();
        });

        it("does not truncate existing complete or larger files on init()", async () => {
            const file1Path = path.join(tmpDir, "file1.bin");
            await fs.mkdir(path.dirname(file1Path), { recursive: true });

            // Write 1000 bytes into a file specified for 500 bytes
            const existingData = Buffer.alloc(1000, "x");
            await fs.writeFile(file1Path, existingData);

            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 500,
                pieceLength: 500,
                fileSpecs: [
                    { path: ["file1.bin"], length: 500, startOffset: 0, endOffset: 500 },
                ],
            });

            await storage.init();

            const stat = await fs.stat(file1Path);
            expect(stat.size).toBe(1000); // Unchanged because size >= file.length

            await storage.close();
        });

        it("throws an error if write or read is attempted before init()", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 500,
                pieceLength: 500,
                fileSpecs: [{ path: ["file.bin"], length: 500, startOffset: 0, endOffset: 500 }],
            });

            await expect(storage.writeInto(0, Buffer.alloc(100))).rejects.toThrow(/initialized/i);
            await expect(storage.readFrom(0, 100)).rejects.toThrow(/initialized/i);
        });
    });

    describe("Positional I/O & Cross-File Operations", () => {
        it("writes and reads back a piece within a single file", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 1000,
                pieceLength: 500,
                fileSpecs: [{ path: ["single.bin"], length: 1000, startOffset: 0, endOffset: 1000 }],
            });

            await storage.init();

            const payload = Buffer.from("Hello Torrent World! ".repeat(10));
            await storage.writeInto(0, payload);

            const readBuf = await storage.readFrom(0, payload.length);
            expect(readBuf.toString()).toBe(payload.toString());

            await storage.close();
        });

        it("seamlessly writes and reads pieces across file boundaries", async () => {
            const { fileSpecs, totalSize, pieceLength } = createMultiFileSpecs();
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize,
                fileSpecs,
                pieceLength,
            });

            await storage.init();

            // Piece 1 (offset 400 to 800) spans across file1 (400-600) and file2 (600-800)
            const crossPiecePayload = Buffer.alloc(400);
            crossPiecePayload.fill("A", 0, 200); // First half goes to file1
            crossPiecePayload.fill("B", 200, 400); // Second half goes to file2

            await storage.writeInto(1, crossPiecePayload);

            // Read piece 1 back as a single unified buffer
            const readPiece = await storage.readFrom(1, 400);
            expect(readPiece.equals(crossPiecePayload)).toBe(true);

            // Verify raw disk contents directly
            const file1Content = await fs.readFile(path.join(tmpDir, "folder", "file1.bin"));
            const file2Content = await fs.readFile(path.join(tmpDir, "folder", "file2.bin"));

            expect(file1Content.subarray(400, 600).toString()).toBe("A".repeat(200));
            expect(file2Content.subarray(0, 200).toString()).toBe("B".repeat(200));

            await storage.close();
        });

        it("supports block-level reading with offset within a piece", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 1000,
                pieceLength: 500,
                fileSpecs: [{ path: ["data.bin"], length: 1000, startOffset: 0, endOffset: 1000 }],
            });

            await storage.init();

            const pieceBuf = Buffer.from("0123456789ABCDEF");
            await storage.writeInto(0, pieceBuf);

            // Read 5 bytes starting at blockOffset 5 within piece 0
            const blockBuf = await storage.readFrom(0, 5, 5);
            expect(blockBuf.toString()).toBe("56789");

            await storage.close();
        });

        it("throws OUT_OF_BOUNDS error when writing or reading past torrent size", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 500,
                pieceLength: 500,
                fileSpecs: [{ path: ["file.bin"], length: 500, startOffset: 0, endOffset: 500 }],
            });

            await storage.init();

            // Attempt write that exceeds total bounds (500 + 10 = 510 > 500)
            await expect(storage.writeInto(0, Buffer.alloc(510))).rejects.toThrow(/boundary/i);

            // Attempt read that exceeds total bounds
            await expect(storage.readFrom(0, 100, 450)).rejects.toThrow(/boundary/i);

            await storage.close();
        });
    });

    describe("Concurrency, Handle Deduplication & Recovery", () => {
        it("deduplicates concurrent first-open requests for the same file handle (#11)", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 1000,
                pieceLength: 500,
                fileSpecs: [{ path: ["shared.bin"], length: 1000, startOffset: 0, endOffset: 1000 }],
            });

            await storage.init();

            vi.mocked(fs.open).mockClear();

            // Issue two parallel writes before the file handle has resolved
            const op1 = storage.writeInto(0, Buffer.alloc(100, "a"));
            const op2 = storage.writeInto(0, Buffer.alloc(100, "b"));

            await Promise.all([op1, op2]);

            // fs.open should have been called EXACTLY ONCE for shared.bin
            expect(fs.open).toHaveBeenCalledTimes(1);

            await storage.close();
        });

        it("clears failed open promises from fileMap so future calls can retry", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 1000,
                pieceLength: 500,
                fileSpecs: [{ path: ["fail.bin"], length: 1000, startOffset: 0, endOffset: 1000 }],
            });

            await storage.init();

            const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            let callCount = 0;

            vi.mocked(fs.open).mockImplementation(async (filePath, flags) => {
                callCount++;
                if (callCount === 1) {
                    throw new Error("EMFILE: Too many open files");
                }
                return actualFs.open(filePath, flags);
            });

            // First call fails and should clean fileMap
            await expect(storage.writeInto(0, Buffer.alloc(100))).rejects.toThrow("EMFILE");

            // Second call retries and succeeds
            await expect(storage.writeInto(0, Buffer.alloc(100))).resolves.not.toThrow();

            await storage.close();
        });
    });

    describe("Lifecycle & Teardown", () => {
        it("drains pending I/O operations before closing descriptors (#12)", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 1000,
                pieceLength: 500,
                fileSpecs: [{ path: ["drain.bin"], length: 1000, startOffset: 0, endOffset: 1000 }],
            });

            await storage.init();

            let writeCompleted = false;

            // Trigger a write operation
            const writePromise = storage.writeInto(0, Buffer.alloc(500, "z")).then(() => {
                writeCompleted = true;
            });

            // Trigger close immediately while write is pending
            const closePromise = storage.close();

            await Promise.all([writePromise, closePromise]);

            // Verify write operation fully settled before close finished
            expect(writeCompleted).toBe(true);
        });

        it("blocks new I/O requests immediately when close() starts", async () => {
            const storage = new TorrentStorage({
                rootDir: tmpDir,
                totalSize: 1000,
                pieceLength: 500,
                fileSpecs: [{ path: ["blocked.bin"], length: 1000, startOffset: 0, endOffset: 1000 }],
            });

            await storage.init();

            const closePromise = storage.close();

            // Immediate request after close initiated must reject with closed message
            await expect(storage.writeInto(0, Buffer.alloc(100))).rejects.toThrow(/closed/i);
            await expect(storage.readFrom(0, 100)).rejects.toThrow(/closed/i);

            await closePromise;
        });
    });
});
