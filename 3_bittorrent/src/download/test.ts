import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { TorrentStorage } from "./TorrentStorage.js";

const TEST_FILE = "./test_output/boundary_test.iso";
const ONE_GB = 1024 * 1024 * 1024; // 1 GiB
const PIECE_SIZE = 1024 * 1024;    // 1 MiB

async function runBoundaryAndPersistenceTests() {
    await fs.rm("./test_output", { recursive: true, force: true });

    // --- 1. Out-of-bounds Write Guard ---
    console.log("=== Test 1: Boundary Guard Failure ===");
    const storage1 = new TorrentStorage({ downloadPath: TEST_FILE, totalSize: ONE_GB });
    await storage1.init();

    const writeOffset = ONE_GB - 100;
    const oversizedBuffer = Buffer.alloc(200); // Exceeds end of file by 100 bytes

    await assert.rejects(
        async () => {
            await storage1.write(writeOffset, oversizedBuffer);
        },
        /Out of bounds write/,
        "Storage failed to reject write extending past totalSize!"
    );
    await storage1.close();
    console.log("✅ Out-of-bounds write correctly rejected.\n");

    // --- 2. End-of-File Boundary Write & Read ---
    console.log("=== Test 2: End-of-File (EOF) Boundary Write ===");
    const storage2 = new TorrentStorage({ downloadPath: TEST_FILE, totalSize: ONE_GB });
    await storage2.init();

    const eofOffset = ONE_GB - PIECE_SIZE;
    const eofPayload = Buffer.alloc(PIECE_SIZE, 0xFE); // Last 1 MiB block

    await storage2.write(eofOffset, eofPayload);

    const eofReadBuf = Buffer.alloc(PIECE_SIZE);
    await storage2.readInto(eofReadBuf, 0, PIECE_SIZE, eofOffset);
    assert.deepStrictEqual(eofReadBuf, eofPayload, "EOF boundary payload corrupted!");
    await storage2.close();
    console.log("✅ End-of-file boundary write/read verified.\n");

    // --- 3. Reopen & Disk Persistence Verification ---
    console.log("=== Test 3: Disk Reopen Persistence ===");
    // Instantiate a brand new storage object pointing to the existing file
    const storageReopened = new TorrentStorage({ downloadPath: TEST_FILE, totalSize: ONE_GB });
    await storageReopened.init();

    const verifyReopenedBuf = Buffer.alloc(PIECE_SIZE);
    await storageReopened.readInto(verifyReopenedBuf, 0, PIECE_SIZE, eofOffset);
    assert.deepStrictEqual(
        verifyReopenedBuf,
        eofPayload,
        "Data failed to persist on disk across process/instance reopen!"
    );

    await storageReopened.close();
    console.log("✅ Disk persistence across instance reopen verified.\n");

    await fs.rm("./test_output", { recursive: true, force: true });
}

runBoundaryAndPersistenceTests().catch((err) => {
    console.error("❌ Test Failed:", err);
    process.exit(1);
});
