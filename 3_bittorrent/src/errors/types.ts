export type CodecErrorCode =
    | 'UNEXPECTED_EOF'
    | 'INVALID_TOKEN'
    | 'INVALID_INTEGER'
    | 'INVALID_STRING_LENGTH'
    | 'STRINGS_OUT_OF_BOUNDS'
    | 'EXPECTED_TERMINATOR'
    | 'TRAILING_DATA';

export type NetworkErrorCode =
    | 'HANDSHAKE_TIMEOUT'
    | 'PEER_FAILED'
    | 'PEER_RESET'
    | 'CONNECTION_REFUSED'
    | 'PROTOCOL_VIOLATION';

export type TrackerErrorCode =
    | 'ANNOUNCE_FAILED'
    | 'SCRAPE_FAILED'
    | 'INVALID_TRACKER_RESPONSE';

export type SocketErrorCode =
    | 'CONNECTION_TIMED_OUT'
    | 'CONNECTION_RESET'
    | 'HANDSHAKE_INCOMPLETE'
    | 'CONNECTION_REFUSED'
    | 'BROKEN_PIPE'
    | 'SOCKET_ERROR';

export type SystemErrorCode = 'UNHANDLED_EXCEPTION';

export type AppErrorCode =
    | CodecErrorCode
    | NetworkErrorCode
    | TrackerErrorCode
    | SystemErrorCode
    | SocketErrorCode;

export type DomainOpts =
    | 'CODEC'
    | 'NETWORK'
    | 'TRACKER'
    | 'SYSTEM'
    | 'SOCKET';

export interface BaseErrorOpts {
    domain: DomainOpts;
    code: AppErrorCode;
    message: string;
    cause?: unknown;
    context?: Record<string, unknown>;
}
