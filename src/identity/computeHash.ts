import crypto from 'crypto';

export function computeSha1Hash(buffer: Buffer): Buffer {
    return crypto.createHash('sha1').update(buffer).digest(); // digest(): Buffer(20bytes)
}
