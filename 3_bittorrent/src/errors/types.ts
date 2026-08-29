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
    | 'PROTOCOL_VIOLATION'
    | 'EXCESSIVE_FRAME_SIZE';

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

export type PeerStateErrorCode =
    | 'INVALID_STATE_TRANSITION'
    | 'INVALID_REQUEST'
    | 'INVALID_ARGUMENT'
    | 'INVALID_PIECE'
    | 'INVALID_CANCEL'
    | 'INVALID_PIECE_INDEX'
    | 'INVALID_HAVE'
    | 'INVALID_BITFIELD'
    | 'PEER_NOT_READY';

export type PieceErrorCode =
    | 'INVALID_ACTIVE_PIECE'
    | 'INVALID_PIECE_INDEX'
    | 'INVALID_BEGIN'
    | 'UNALIGNED_BLOCK';

export type SystemErrorCode = 'UNHANDLED_EXCEPTION';

export type AppErrorCode =
    | CodecErrorCode
    | NetworkErrorCode
    | TrackerErrorCode
    | SystemErrorCode
    | SocketErrorCode
    | PeerStateErrorCode
    | PieceErrorCode;

export type DomainOpts =
    | 'CODEC'
    | 'NETWORK'
    | 'TRACKER'
    | 'SYSTEM'
    | 'SOCKET'
    | 'PEER_STATE'
    | 'PIECE_STATE';

export interface BaseErrorOpts {
    domain: DomainOpts;
    code: AppErrorCode;
    message: string;
    cause?: unknown;
    context?: Record<string, unknown>;
}

export type LifecycleStateOpts =
    | 'NEW'
    | 'CONNECTING'
    | 'CONNECTED'
    | 'READY'
    | 'CLOSED'
    | 'FAILED';
