export const INFO_BYTES = Buffer.from([0x69, 0x6e, 0x66, 0x6f]); // 'info'

export interface InfoSection {
    start: number;
    end: number;
    raw: Buffer;
}

export interface ParsedString {
    len: number;
    payloadStart: number;
    end: number;
}
