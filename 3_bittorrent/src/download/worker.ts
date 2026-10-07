import * as fs from "node:fs/promises";
import * as path from "node:path";

const TEST_FILE = "./test_output/worker_thread.bin";
const SPARSE_FILE_SIZE = Math.pow(1024, 3); // 1 GB
const PIECE_SIZE = Math.pow(1024, 2);        // 1 MB

await fs.mkdir(path.dirname(TEST_FILE), { recursive: true });

// Note: 'w+' allows us to open/create the file fresh, then truncate it.
const handle = await fs.open(TEST_FILE, "w+");
await handle.truncate(SPARSE_FILE_SIZE);

const piece1 = Buffer.alloc(PIECE_SIZE, 'A');
const piece2 = Buffer.alloc(PIECE_SIZE, 'B');


const writeOffset1 = 0;
const writeOffset2 = PIECE_SIZE; // 1048576 (Exactly after piece 1)

await writeConcurrent();
await readAndVerify();
await handle.close(); // Remember to close the file handle!

fs.rm(TEST_FILE);

async function writeConcurrent(): Promise<void> {
    console.log("=== Initiate Test for concurrent write using same file handle ===");

    try {
        await Promise.all([
            handle.write(piece1, 0, PIECE_SIZE, writeOffset1),
            handle.write(piece2, 0, PIECE_SIZE, writeOffset2)
        ]);
    } catch (err) {
        console.error("Write error:", err);
    }
}

async function readAndVerify(): Promise<void> {
    console.log("=== Initiate Test for concurrent read and match using same file handle ===");

    const buf1 = Buffer.alloc(PIECE_SIZE);
    const buf2 = Buffer.alloc(PIECE_SIZE);

    try {
        // Read concurrently as well
        await Promise.all([
            handle.read(buf1, 0, PIECE_SIZE, writeOffset1),
            handle.read(buf2, 0, PIECE_SIZE, writeOffset2)
        ]);
    } catch (err) {
        console.error("Read error:", err);
    } finally {
        if (buf1.equals(piece1)) {
            console.log("✅ Test Passed for piece 1: written and verified successfully.");
        } else {
            console.log("❌ Test Failed for piece 1: Data mismatch or corrupted.");
        }

        if (buf2.equals(piece2)) {
            console.log("✅ Test Passed for piece 2: written and verified successfully.");
        } else {
            console.log("❌ Test Failed for piece 2: Data mismatch or corrupted.");
        }
    }
}
