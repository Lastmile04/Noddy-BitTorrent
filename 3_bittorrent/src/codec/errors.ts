export type ParseErrorCode =
    | 'UNEXPECTED_EOF'
    | 'INVALID_TOKEN'
    | 'INVALID_INTEGER'
    | 'INVALID_STRING_LENGTH'
    | 'STRINGS_OUT_OF_BOUNDS'
    | 'EXPECTED_TERMINATOR'
    | 'TRAILING_DATA';

export interface ParserErrorOptions {
    code: ParseErrorCode;
    message: string;
    cause?: unknown;
    byteOffset?: number;
}

export class ParseError extends Error {
    // only define the custom properties you want to attach not the ones inherited from the Error class
    override readonly name = 'ParseError';
    readonly code: ParseErrorCode;
    readonly byteOffset?: number;

    constructor({ code, message, cause, byteOffset }: ParserErrorOptions) {
        super(message);
        this.code = code;
        this.cause = cause;
        this.byteOffset = byteOffset;

        // for correct prototype chaining by setting the default prototype blueprint from super to the initially defined one 
        Object.setPrototypeOf(this, ParseError.prototype);

        // to trim the useless stack trace calls and only tell where the call was made exactly in business logic
        if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
    }
}

