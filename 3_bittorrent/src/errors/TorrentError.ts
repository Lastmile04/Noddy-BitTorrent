import {
    AppErrorCode,
    BaseErrorOpts,
    CodecErrorCode,
    DomainOpts,
    NetworkErrorCode,
    PeerStateErrorCode,
    PieceErrorCode,
    SocketErrorCode,
    TrackerErrorCode,
} from "./types.js";

export class TorrentError extends Error {
    override readonly name = 'TorrentError';
    isOperational: boolean;
    readonly domain: DomainOpts;
    readonly code: AppErrorCode;
    readonly context: Record<string, unknown>;

    constructor({ domain, code, message, cause, context }: BaseErrorOpts) {
        super(message);

        this.isOperational = true;
        this.domain = domain;
        this.code = code;
        this.cause = cause;
        this.context = context || {};

        Object.setPrototypeOf(this, TorrentError.prototype);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

const SOCKET_ERROR_MAP: Record<string, SocketErrorCode> = {
    ECONNREFUSED: 'CONNECTION_REFUSED',
    ETIMEDOUT: 'CONNECTION_TIMED_OUT',
    ECONNRESET: 'CONNECTION_RESET',
    EPIPE: 'BROKEN_PIPE',
    ENOTFOUND: 'CONNECTION_REFUSED',
    EHOSTUNREACH: 'SOCKET_ERROR',
};

export const ErrorFactory = {
    codec: (code: CodecErrorCode, message: string, context?: Record<string, unknown>, cause?: unknown) => {
        return new TorrentError({
            domain: 'CODEC',
            code,
            message,
            context,
            cause,
        });
    },

    network: (code: NetworkErrorCode, message: string, context?: Record<string, unknown>, cause?: unknown) => {
        return new TorrentError({
            domain: 'NETWORK',
            code,
            message,
            context,
            cause,
        });
    },

    tracker: (code: TrackerErrorCode, message: string, context?: Record<string, unknown>, cause?: unknown) => {
        return new TorrentError({
            domain: 'TRACKER',
            code,
            message,
            context,
            cause,
        });
    },

    socket: (code: SocketErrorCode, message: string, context?: Record<string, unknown>, cause?: unknown) => {
        return new TorrentError({
            domain: 'SOCKET',
            code,
            message,
            context,
            cause,
        });
    },

    peer_state: (code: PeerStateErrorCode, message: string, context?: Record<string, unknown>, cause?: unknown) => {
        return new TorrentError({
            domain: 'PEER_STATE',
            code,
            message,
            context,
            cause,
        });
    },

    piece_state: (code: PieceErrorCode, message: string, context?: Record<string, unknown>, cause?: unknown) => {
        return new TorrentError({
            domain: 'PIECE_STATE',
            code,
            message,
            context,
            cause,
        });
    },

    fromSocketError: (err: unknown): TorrentError => {
        if (err instanceof TorrentError) return err;

        const sysErr = err as NodeJS.ErrnoException;
        if (sysErr?.code && sysErr.code in SOCKET_ERROR_MAP) {
            const mappedCode = SOCKET_ERROR_MAP[sysErr.code];
            return ErrorFactory.socket(
                mappedCode,
                sysErr.message || 'Underlying transport socket error',
                { sysCode: sysErr.code },
                err
            );
        }

        return ErrorFactory.normalize(err);
    },

    normalize: (err: unknown): TorrentError => {
        if (err instanceof TorrentError) return err;

        const message = err instanceof Error ? err.message : 'Unknown fatal error';

        const wrappedError = new TorrentError({
            domain: 'SYSTEM',
            code: 'UNHANDLED_EXCEPTION',
            message,
            cause: err,
            context: { originalError: err },
        });

        wrappedError.isOperational = false;

        return wrappedError;
    },
};
