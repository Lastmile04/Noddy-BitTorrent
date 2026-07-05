export const BencodeTokens = {
    //Structural tokens
    DICTIONARY_START: 0x64, //d
    LIST_START:       0x6C, //l
    INTEGER_START:    0x69, //i
    END_MARKER:       0x65, //e
    STRING_DELIMITER: 0x3A, // :
    // Parsing tokens
    NEGATIVE_SIGN:    0x2D, // -
    // Digit range
    ASCII_ZERO:       0x30, // 0
    ASCII_NINE:       0x39  // 9
} as const

// a helper function to tell if the byte is between 0-9
export function isAscaiiIDigit(byte: number) {
    return byte >= BencodeTokens.ASCII_ZERO &&
           byte <= BencodeTokens.ASCII_NINE
}


