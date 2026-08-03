//NOTE: Important parser rules:
//- all type parser functions return a parseResult type object 
//- nested results in type parser dict and list are nodes instead of parseResult object
//- string and integer type parser function return the parseResult object if not called inside a nested function 

import type {
    Node,
    ByteStringNode,
    IntegerNode,
    ListNode,
    DictNode,
    ParseResult
} from "./ast.js";

import { ParseError } from "./errors.js";
import { BencodeTokens, isAsciiDigit } from "./grammar.js";

export function decode(buf: Buffer): Node {
    const offset = 0;
    const decodedObj = parseNode(buf, offset);
    if (decodedObj.nextOffset !== buf.length) {
        throw new ParseError({
            code: 'TRAILING_DATA',
            message: 'Unparsed bytes remaining after the root value',
            byteOffset: decodedObj.nextOffset,
        });
    }
    return decodedObj.node;
}

export function parseNode(buf: Buffer, offset: number): ParseResult<Node> {
    if (offset >= buf.length) {
        throw new ParseError({
            code: 'UNEXPECTED_EOF',
            message: 'Unexpected end of buffer while expecting a value',
            byteOffset: offset,
        });
    }

    const peek = buf[offset];

    switch (peek) {
        case BencodeTokens.DICTIONARY_START:
            return parseDict(buf, offset);
        case BencodeTokens.LIST_START:
            return parseList(buf, offset);
        case BencodeTokens.INTEGER_START:
            return parseInteger(buf, offset);
        case BencodeTokens.END_MARKER:
            throw new ParseError({
                code: 'INVALID_TOKEN',
                message: 'Unexpected END_MARKER ("e") where a value was expected',
                byteOffset: offset,
            });
        default:
            if (isAsciiDigit(peek)) return parseString(buf, offset);
            throw new ParseError({
                code: 'INVALID_TOKEN',
                message: `Invalid token byte: 0x${peek.toString(16)}`,
                byteOffset: offset,
            });
    }
}

export function parseDict(buf: Buffer, offset: number): ParseResult<DictNode> {
    const pairs: [ByteStringNode, Node][] = [];
    let i = offset + 1; // Skip initial 'd'

    while (i < buf.length) {
        const byte = buf[i];

        if (byte === BencodeTokens.END_MARKER) {
            return {
                node: { type: 'DICT', value: pairs },
                nextOffset: i + 1, // Skip closing 'e'
            };
        }

        if (isAsciiDigit(byte)) {
            const keyResult = parseString(buf, i);
            i = keyResult.nextOffset;

            const valueResult = parseNode(buf, i);
            i = valueResult.nextOffset;

            pairs.push([keyResult.node, valueResult.node]);
        } else {
            throw new ParseError({
                code: 'INVALID_TOKEN',
                message: `Dictionary keys must be strings, found 0x${byte.toString(16)}`,
                byteOffset: i,
            });
        }
    }

    throw new ParseError({
        code: 'UNEXPECTED_EOF',
        message: 'Unterminated dictionary: missing closing "e" marker',
        byteOffset: offset,
    });
}

export function parseList(buf: Buffer, offset: number): ParseResult<ListNode> {
    let i = offset + 1; // Skip initial 'l'
    const list: Node[] = [];

    while (i < buf.length) {
        const byte = buf[i];

        if (byte === BencodeTokens.END_MARKER) {
            return {
                node: { type: 'LIST', value: list },
                nextOffset: i + 1, // Skip closing 'e'
            };
        }

        const itemResult = parseNode(buf, i);
        list.push(itemResult.node);
        i = itemResult.nextOffset;
    }

    throw new ParseError({
        code: 'UNEXPECTED_EOF',
        message: 'Unterminated list: missing closing "e" marker',
        byteOffset: offset,
    });
}

export function parseInteger(buf: Buffer, offset: number): ParseResult<IntegerNode> {
    let i = offset + 1; // Skip initial 'i'
    let sign = 1;

    if (i >= buf.length) {
        throw new ParseError({
            code: 'UNEXPECTED_EOF',
            message: 'Unterminated integer payload',
            byteOffset: offset,
        });
    }

    // Handle negative sign
    if (buf[i] === BencodeTokens.NEGATIVE_SIGN) {
        sign = -1;
        i++;
    }

    const startDigits = i;
    let integer = 0;

    while (i < buf.length) {
        const byte = buf[i];

        if (byte === BencodeTokens.END_MARKER) {
            const digitLength = i - startDigits;

            if (digitLength === 0) {
                throw new ParseError({
                    code: 'INVALID_INTEGER',
                    message: 'Empty integer expression "i-e" or "ie"',
                    byteOffset: offset,
                });
            }

            // Check for leading zero: e.g., i03e or i-0e
            if (digitLength > 1 && buf[startDigits] === BencodeTokens.ASCII_ZERO) {
                throw new ParseError({
                    code: 'INVALID_INTEGER',
                    message: 'Bencode violation: Leading zeros are forbidden',
                    byteOffset: startDigits,
                });
            }

            // Check for negative zero: i-0e
            if (sign === -1 && integer === 0) {
                throw new ParseError({
                    code: 'INVALID_INTEGER',
                    message: 'Bencode violation: Negative zero "-0" is forbidden',
                    byteOffset: offset,
                });
            }

            return {
                node: { type: 'INTEGER', value: integer * sign },
                nextOffset: i + 1, // Skip closing 'e'
            };
        }

        if (!isAsciiDigit(byte)) {
            throw new ParseError({
                code: 'INVALID_INTEGER',
                message: `Invalid character in integer: '${String.fromCharCode(byte)}'`,
                byteOffset: i,
            });
        }

        const digit = byte - BencodeTokens.ASCII_ZERO;
        integer = integer * 10 + digit;
        i++;
    }

    throw new ParseError({
        code: 'UNEXPECTED_EOF',
        message: 'Unterminated integer: missing closing "e" marker',
        byteOffset: offset,
    });
}

export function parseString(buf: Buffer, offset: number): ParseResult<ByteStringNode> {
    let i = offset;
    let len = 0;
    const startOffset = i;

    // Read ASCII digits for string length until delimiter ':'
    while (i < buf.length && isAsciiDigit(buf[i])) {
        const digit = buf[i] - BencodeTokens.ASCII_ZERO;
        len = len * 10 + digit;
        i++;
    }

    const digitCount = i - startOffset;

    if (digitCount === 0) {
        throw new ParseError({
            code: 'INVALID_TOKEN',
            message: 'Expected string length digit',
            byteOffset: i,
        });
    }

    // Check for leading zeros in length prefix (e.g. "04:spam")
    if (digitCount > 1 && buf[startOffset] === BencodeTokens.ASCII_ZERO) {
        throw new ParseError({
            code: 'INVALID_TOKEN',
            message: 'Bencode violation: Leading zeros in string length prefix',
            byteOffset: startOffset,
        });
    }

    // Validate string delimiter ':' (0x3A)
    if (i >= buf.length || buf[i] !== BencodeTokens.STRING_DELIMITER) {
        throw new ParseError({
            code: 'INVALID_TOKEN',
            message: 'Missing ":" delimiter after string length prefix',
            byteOffset: i,
        });
    }

    i++; // Skip delimiter ':'
    const payloadStart = i;
    const payloadEnd = payloadStart + len;

    // Verify buffer has enough bytes for payload
    if (payloadEnd > buf.length) {
        throw new ParseError({
            code: 'UNEXPECTED_EOF',
            message: `String payload truncated: expected ${len} bytes but only ${buf.length - payloadStart} remain`,
            byteOffset: payloadStart,
        });
    }

    // Zero-allocation buffer view using subarray
    const strVal = buf.subarray(payloadStart, payloadEnd);

    return {
        node: {
            type: 'BYTE_STRING',
            value: strVal,
        },
        nextOffset: payloadEnd,
    };
}
