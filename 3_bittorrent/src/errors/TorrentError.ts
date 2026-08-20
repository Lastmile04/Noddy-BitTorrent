import { Socket } from "node:dgram";
import { AppErrorCode, BaseErrorOpts, CodecErrorCode, NetworkErrorCode, SocketErrorCode, TrackerErrorCode } from "./types.js";
import { domainToASCII } from "node:url";

class TorrentError extends Error {
    override readonly name = 'TorrentError';
    isOperational: boolean;
    domain: string;
    code: AppErrorCode
    context: Record<string, unknown>;

    constructor({ domain, code, message, cause, context }: BaseErrorOpts) {
        super(message);

        this.isOperational = true;
        this.domain = domain;
        this.message = message;
        this.code = code;
        this.cause = cause;
        this.context = context || {};

        Object.setPrototypeOf(this, TorrentError.prototype);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

export const ErrorFactory = {
    codec: (code: CodecErrorCode, message: string, context?: Record<string, unknown>) => {
        return new TorrentError({
            domain: 'CODEC',
            code,
            message,
            context
        });
    },

    network: (code: NetworkErrorCode, message: string, context?: Record<string, unknown>) => {
        return new TorrentError({
            domain: 'NETWORK',
            code,
            message,
            context
        });
    },

    tracker: (code: TrackerErrorCode, message: string, context?: Record<string, unknown>) => {
        return new TorrentError({
            domain: 'TRACKER',
            code,
            message,
            context
        });
    },

    socket: (code: SocketErrorCode, message: string, context?: Record<string, unknown>) => {
        return new TorrentError({
            domain: 'SOCKET',
            code,
            message,
            context
        });
    },

    normalize: (err: unknown): TorrentError => {
        if (err instanceof TorrentError) return err; // for prototype chaining

        const message = err instanceof Error ? err.message : 'Unknown fatal error';

        const wrappedError = new TorrentError({
            domain: 'SYSTEM',
            code: 'UNHANDLED_EXCEPTION',
            message,
            cause: err,
            context: { originalError: err }
        });

        wrappedError.isOperational = false;

        return wrappedError;
    }
};

