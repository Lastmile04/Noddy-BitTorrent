/** 
 * @param {Buffer} buffer The actual buffer with data
 * @param {Number} offset The offset at which to peek the type of data.
 * @public
 */

function parseNode(buffer: Buffer, offset: number) {
    const peek: number = buffer[offset];
    switch (peek) {}
}

