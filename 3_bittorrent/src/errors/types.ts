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
    | 'PEER_UNAVAILABLE'
    | 'SOCKET_NOT_WRITABLE'
    | 'PEER_NOT_READY';

export type PieceErrorCode =
    | 'INVALID_ACTIVE_PIECE'
    | 'INVALID_PIECE_INDEX'
    | 'INVALID_BEGIN'
    | 'INVALID_BLOCK_SIZE'
    | 'UNALIGNED_BLOCK';

export type SystemErrorCode = 'UNHANDLED_EXCEPTION';

export type SchedulerErrorCode =
    | 'SCHEDULER_DESTROYED'
    | 'INVARIANT_VIOLATION'
    ;

export type AppErrorCode =
    | CodecErrorCode
    | NetworkErrorCode
    | TrackerErrorCode
    | SystemErrorCode
    | SocketErrorCode
    | PeerStateErrorCode
    | SchedulerErrorCode
    | StorageErrorCode
    | PieceErrorCode;

export interface BaseErrorOpts {
    domain: DomainOpts;
    code: AppErrorCode;
    message: string;
    cause?: unknown;
    context?: Record<string, unknown>;
}

export type StorageErrorCode =
    | 'DISK_FULL'              // ENOSPC (Session-recoverable)
    | 'PERMISSION_DENIED'      // EACCES / EPERM (Fatal)
    | 'FILE_NOT_FOUND'         // ENOENT (Fatal)
    | 'IO_ERROR'               // EIO (Fatal)
    | 'TOO_MANY_OPEN_FILES'    // EMFILE / ENFILE (Internally retried)
    | 'BAD_DESCRIPTOR'         // EBADF (Internally retried)
    | 'STORAGE_NOT_INITIALIZED'
    | 'STORAGE_CLOSED'
    | 'OUT_OF_BOUNDS'
    | 'WRITE_FAILED'
    | 'READ_FAILED';

export type DomainOpts =
    | 'CODEC'
    | 'NETWORK'
    | 'TRACKER'
    | 'SYSTEM'
    | 'SOCKET'
    | 'PEER_STATE'
    | 'PIECE_STATE'
    | 'SCHEDULER_STATE'
    | 'STORAGE';

export const STORAGE_ERROR_MAP: Record<string, StorageErrorCode> = {
    ENOSPC: 'DISK_FULL',
    EACCES: 'PERMISSION_DENIED',
    EPERM: 'PERMISSION_DENIED',
    ENOENT: 'FILE_NOT_FOUND',
    EIO: 'IO_ERROR',
    EBADF: 'BAD_DESCRIPTOR',
    EMFILE: 'TOO_MANY_OPEN_FILES',
    ENFILE: 'TOO_MANY_OPEN_FILES',
};
