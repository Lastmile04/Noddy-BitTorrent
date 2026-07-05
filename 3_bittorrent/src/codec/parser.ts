/**
 * @param buffer The buffer containing bencoded data.
 * @param offset The offset at which to peek the next value type.
 */

function parseNode(buffer: Buffer, offset: number) {
    const peek: number = buffer[offset];
    switch (peek) {}
}

