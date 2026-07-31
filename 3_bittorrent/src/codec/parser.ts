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
    let decoded_value = parseNode(buf, offset);
    if (decoded_value.nextOffset !== buf.length) {
        throw new ParseError({
            code: 'TRAILING_DATA',
            message: 'There are unparsed bytes remaining after the root value',
            byteOffset: decoded_value.nextOffset,
        });
    }
    return decoded_value.node;
}

export function parseNode(buf: Buffer, offset: number): ParseResult {
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
                message: 'Unexpected EOF token whlile value was expected',
                byteOffset: offset
            });
        default:
            if (isAsciiDigit(peek)) return parseString(buf, offset);
            throw new ParseError({
                code: 'INVALID_TOKEN',
                message: `Invalid token of type ${peek.toString(16)}`,
                byteOffset: offset
            });
    }
}

export function parseDict(buf: Buffer, offset: number): ParseResult<DictNode> {
    const pairs: [ByteStringNode, Node][] = [];
    let i = offset + 1; // Skip the initial 'd' prefix

    while (i < buf.length) {
        const byte = buf[i];

        // Termination
        if (byte === BencodeTokens.END_MARKER) {
            return {
                node: {
                    type: 'DICT',
                    value: pairs,
                },
                nextOffset: i + 1, // Skip the closing 'e'
            };
        }

        // Key Extraction: Dict keys MUST be bencode strings (start with 0-9)
        if (isAsciiDigit(byte)) {
            const keyResult = parseString(buf, i);
            const keyNode = keyResult.node;
            i = keyResult.nextOffset;

            const valueResult = parseNode(buf, i);
            const valueNode = valueResult.node;
            pairs.push([keyNode, valueNode]);
            i = valueResult.nextOffset;
        } else {
            // Invalid Key Guard
            throw new ParseError({
                code: 'INVALID_TOKEN',
                message: `Dictionary keys must be strings, found invalid prefix byte 0x${byte.toString(16)}`,
                byteOffset: i,
            });
        }
    }

    // Truncated Payload Guard (Loop finished without finding 'e')
    throw new ParseError({
        code: 'UNEXPECTED_EOF',
        message: 'Unterminated dictionary: missing closing "e" marker',
        byteOffset: offset,
    });
}

export function parseList(buf: Buffer, offset: number): ParseResult<ListNode> {

}

export function parseInteger(buf: Buffer, offset: number): ParseResult<IntegerNode> {

}

export function parseString(buf: Buffer, offset: number): ParseResult<ByteStringNode> {

}

