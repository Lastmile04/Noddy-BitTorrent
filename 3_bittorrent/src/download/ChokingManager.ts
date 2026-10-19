import EventEmitter from "node:events";
import { BitTorrentPeer } from "../transport/BitTorrentPeer.js";
import { PeerPoolManager } from "./PeerPoolManager.js";

export class ChokingManager extends EventEmitter {
    private readonly regularIntervalMs: number = 10000;     // 10 seconds
    private readonly optimisticIntervalMs: number = 30000;  // 30 seconds

    private regularTimer: NodeJS.Timeout | null = null;
    private optimisticTimer: NodeJS.Timeout | null = null;
    private optimisticPeer: BitTorrentPeer | null = null;

    private readonly maxUnchoked: number = 4;
    private pool: PeerPoolManager;

    constructor(pool: PeerPoolManager) {
        super();
        this.pool = pool;
    }

    public start(): void {
        if (this.regularTimer || this.optimisticTimer) return;

        this.regularTimer = setInterval(() => {
            this.runRegularUnchoke();
        }, this.regularIntervalMs);

        this.optimisticTimer = setInterval(() => {
            this.runOptimisticUnchoke();
        }, this.optimisticIntervalMs);
    }

    private runRegularUnchoke(): void {
        const intersted: BitTorrentPeer[] = this.pool.getInterested();

        
        
    }
    private runOptimisticUnchoke(): void { }
}


