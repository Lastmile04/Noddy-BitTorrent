import { RateSample } from "./types.js";

export class RollingRateTracker {
    private readonly windowMs: number;
    private events: RateSample[] = [];
    private currentByteSum: number = 0;

    constructor(windowMs: number = 10000) {
        this.windowMs = windowMs;
    }

    public addBytes(bytes: number): void {

        if (typeof bytes !== 'number' || bytes <= 0 || !Number.isFinite(bytes)) {
            return;
        }

        const now = Date.now();
        this.events.push({ timestamp: now, bytes });
        this.currentByteSum += bytes;
    }

    public getRate(): number {
        const now = Date.now();
        const cutoff = now - this.windowMs;

        while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
            const expired = this.events.shift()!;
            this.currentByteSum -= expired.bytes;
        }

        if (this.currentByteSum <= 0) {
            this.currentByteSum = 0;
            return 0
        }

        const windowSec = this.windowMs / 1000;
        return this.currentByteSum / windowSec;
    }

}
