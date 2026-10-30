export function percentEncode(buffer){
    let result = '';

    for(let i = 0; i<buffer.length; i++){
        const byte = buffer[i];
        const hex = byte.toString(16);
        const paddedHex = hex.padStart(2, '0').toUpperCase();
        result += '%' + paddedHex;
    }
    return result;
}