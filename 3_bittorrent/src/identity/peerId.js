import crypto from 'crypto';
// -XX####-############
// -XX = Two-letter client code, #### = Version number (4 digits), - = Separator, ############ = Random characters (12 bytes)

export function generatePeerId(client, ver) {
    // Ensure client code is 2 characters
    const code = client.slice(0, 2).toUpperCase();
    // Ensure version is 4 digits (pad with zeros if needed)
    const version = ver.padStart(4, '0').slice(0, 4);
    // Build prefix: -XX####-
    const prefix = Buffer.from(`-${code}${version}-`, 'ascii'); // 8 bytes
    const randomBytes = crypto.randomBytes(12);
    return Buffer.concat([prefix, randomBytes], 20);
}
