import { Buffer } from 'buffer';

const MAX_ALLOWED = 655360;
// helper function
function isDigit(byte) {
    return byte >= 0x30 && byte <= 0x39
}

const ProtocolTypes = {
    INTEGER: 'Integer',
    STRING: 'String', // Represents byte sequences (Buffer)
    LIST: 'List',
    DICT: 'Dictionary'
};

//main parsing decider
function decode(buffer, offset) {
    const peek = buffer[offset];
    switch (peek) {
        case 0x64: // 'd' -> Dictionary
            return parseDictionary(buffer, offset);
        case 0x6c: // 'l' -> list
            return parseList(buffer, offset);
        case 0x69: // 'i' -> integer
            return parseInteger(buffer, offset);
        case 0x65: // 'e' -> End marker
            throw new Error(`Unexpected end marker at offset ${offset}`);
        default:
            if (isDigit(peek)) {
                return parseString(buffer, offset);
            }
            throw new Error(`Unknown type ${peek.toString(16)} at offset ${offset}`);
    }
}
// integer parsing
function parseInteger(buffer, offset) {
    let i = offset + 1; //skip 'i'
    let sign = 1;
    let result = 0;
    // validation check for -ive int
    if (buffer[i] === 0x2d) {
        sign = -1;
        i++;
    }
    // Validation flags
    let hasDigit = false;
    let isFirst = true;
    let firstDigitWasZero = false;
    // Accumulate data numerically one by one
    while (i < buffer.length) {
        const byte = buffer[i];
        // Termination logic
        if (byte === 0x65) {
            if (!hasDigit) throw new Error('Empty Integer');
            if (sign === -1 && result === 0) throw new Error("Invalid Integer: value can't be -0");
            const final_res = result * sign;
            const newOffset = i + 1;
            return {
                value: { type: ProtocolTypes.INTEGER, value: final_res },
                nextOffset: newOffset //skip e
            }
        }
        if (!isDigit(byte)) throw new Error(`Invalid digit: ${String.fromCharCode(byte)}`);
        const digit = byte - 0x30;
        // Semantic Check (Leading zeros)
        if (isFirst && digit === 0) firstDigitWasZero = true;
        if (firstDigitWasZero && !isFirst) throw new Error("Protocol violation: No leading zeros allowed");
        // Accumulation(Shift and add)
        result = result * 10 + digit;
        isFirst = false;
        hasDigit = true;
        i++;
    }
    return {
        incomplete: true,
        nextOffset: offset
    };
}
// string parsing
function parseString(buffer, offset) {
    let i = offset
    let strLength = 0;
    let payloadStart = 0;
    // flags
    let isFirst = true;
    let firstDigitWasZero = false;
    let sawColon = false;
    let hasLength = false;
    while (i < buffer.length) {
        const byte = buffer[i];
        if (byte === 0x2d) throw new Error('Protocol violation: No negative byte allowed');
        // for length prefix (metadata)
        if (isDigit(byte)) {
            const digit = byte - 0x30;
            if (firstDigitWasZero && !isFirst) throw new Error('Protocol violation: No leading Zeros allowed');
            if (isFirst && digit === 0) firstDigitWasZero = true;
            strLength = strLength * 10 + digit;
            isFirst = false;
            hasLength = true;
            i++;
        }
        else if (byte === 0x3a) { //Length parsing is done
            if (!hasLength) throw new Error('Protocol violation: Empty String');
            i += 1;
            payloadStart = i;
            sawColon = true;
            break;
        }
        else {
            throw new Error('Protocol violation: First byte of metadata is not a digit');
        }
    }
    if (strLength > MAX_ALLOWED) throw new Error('Protocol violation: metadata length exceed the allowed limit');
    if (!sawColon) {
        return {
            incomplete: true,
            nextOffset: offset
        };
    }
    const payloadEnd = payloadStart + strLength;
    if (buffer.length >= payloadEnd) {
        const strValue = buffer.slice(payloadStart, payloadEnd);
        return {
            value: { type: ProtocolTypes.STRING, value: strValue },
            nextOffset: payloadEnd
        };
    } else {
        return {
            incomplete: true,
            nextOffset: offset
        };
    }
}
// list parsing
function parseList(buffer, offset) {
    if (buffer[offset] !== 0x6c) throw new Error('Protocol violation: first byte is not "0x6c" ');
    const listStartOffset = offset;
    let i = offset + 1;
    let listItems = [];
    while (i < buffer.length) {
        const byte = buffer[i];
        // Termination logic
        if (byte === 0x65) { //'e'
            return {
                value: { type: ProtocolTypes.LIST, value: listItems },
                nextOffset: i + 1 //skip 'e'
            };
        } else {
            const result = decode(buffer, i);
            if (result.incomplete) {
                return {
                    incomplete: true,
                    nextOffset: listStartOffset
                };
            }
            const { value, nextOffset } = result;
            listItems.push(value);
            i = nextOffset;
        }
    }
    return {
        incomplete: true,
        nextOffset: listStartOffset
    };
}
//dictionary parsing
function parseDictionary(buffer, offset) {
    if (buffer[offset] !== 0x64) throw new Error('Protocol violation: Expected dictionary');
    const dictStartOffset = offset;
    let i = offset + 1;
    let pairs = [];

    while (i < buffer.length) {
        const byte = buffer[i];
        // Termination logic
        if (byte === 0x65) {
            return {
                value: { type: ProtocolTypes.DICT, value: pairs },
                nextOffset: i + 1 //skip 'e'
            }
        }
        if (isDigit(byte)) {
            // phase 1: Key extraction
            const keyResult = parseString(buffer, i);
            if (keyResult.incomplete) {
                return {
                    incomplete: true,
                    nextOffset: dictStartOffset
                };
            }
            const keyIR = keyResult.value;
            const keyBuffer = keyIR.value;
            i = keyResult.nextOffset;
            // boundary check
            if (i >= buffer.length) return { incomplete: true, nextOffset: dictStartOffset };
            // phase 2: value extraction
            const valueResult = decode(buffer, i);
            if (valueResult.incomplete) {
                return {
                    incomplete: true,
                    nextOffset: dictStartOffset
                };
            }
            pairs.push([keyBuffer, valueResult.value]);
            i = valueResult.nextOffset;
        } else {
            throw new Error('Protocol violation: Mandatory String byte missing!')
        }
    }
    return {
        incomplete: true,
        nextOffset: dictStartOffset
    };
}


function encode(irObject) {

    // Only accept Valid Protocol Values
    if (!irObject || !irObject.type) {
        throw new Error("Protocol Violation: Encoder received a non-IR value");
    }

    switch (irObject.type) {
        case ProtocolTypes.INTEGER:
            return encodeInteger(irObject.value);

        case ProtocolTypes.STRING:
            return encodeString(irObject.value);

        case ProtocolTypes.LIST:
            return encodeList(irObject.value);

        case ProtocolTypes.DICT:
            return encodeDict(irObject.value); // Expects strict pairs

        default:
            throw new Error(`Unknown Protocol Type: ${irObject.type}`);
    }
}

function encodeString(value) {
    if (!Buffer.isBuffer(value)) throw new Error('Protocol violation: BenCode string must be Buffer');

    return Buffer.concat([
        Buffer.from(String(value.length)),
        Buffer.from(':'),
        value
    ]);
}

function encodeInteger(value) {
    return Buffer.concat([
        Buffer.from('i'),
        Buffer.from(String(value)),
        Buffer.from('e')
    ]);
}


function encodeList(value) {
    const items = value.map(item => encode(item));

    return Buffer.concat([
        Buffer.from('l'),
        ...items,
        Buffer.from('e')
    ]);
}

function encodeDict(pairs) {
    const parts = [Buffer.from('d')];
    const sortedPairs = [...pairs];

    sortedPairs.sort((a, b) => Buffer.compare(a[0], b[0]));

    for (const [keyBuffer, valIR] of sortedPairs) {
        if (!Buffer.isBuffer(keyBuffer)) throw new Error('Protocol violation: Dictionary key must be a Buffer');

        parts.push(encodeString(keyBuffer));
        parts.push(encode(valIR));
    }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
}

export { decode, encode, ProtocolTypes };

//Optimize the buffer growth.
// Have to implement CircularBuffer/Buffer Pools
