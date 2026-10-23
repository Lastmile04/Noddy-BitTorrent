import { BitTorrentPeer } from "../transport/BitTorrentPeer.js";
import { PeerPoolManager } from "./PeerPoolManager.js";

type ClientPhase = "Leecher" | "Seeder";

export class ChokingManager {
    private readonly regularIntervalMs: number = 10000;     // 10 seconds
    private readonly optimisticIntervalMs: number = 30000;  // 30 seconds

    private regularTimer: NodeJS.Timeout | null = null;
    private optimisticTimer: NodeJS.Timeout | null = null;
    private optimisticPeer: BitTorrentPeer | null = null;

    private readonly maxUnchoked: number = 4; // Total slots (3 Regular + 1 Optimistic)
    private pool: PeerPoolManager;
    private CurrentClientPhase: ClientPhase = "Leecher";

    constructor(pool: PeerPoolManager) {
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
        // Validate optimistic peer eligibility first
        if (this.optimisticPeer && !this.optimisticPeer.remotePeerState.peerInterested) {
            this.optimisticPeer = null;
        }

        const interested = this.pool.getInterested();

        // NOTE: Do NOT return early if interested is empty! 
        // If it's empty, our desired selection is empty, so everyone must be choked.

        // Sort interested peers by rate descending
        const sortedPeers = interested.sort((a, b) => {
            if (this.CurrentClientPhase === "Leecher") {
                return b.getDownloadRate() - a.getDownloadRate();
            } else {
                return b.getUploadRate() - a.getUploadRate();
            }
        });

        // Reserve 1 slot for optimistic peer if active, leaving 3 for regular slots
        const regularSlotCount = this.optimisticPeer ? this.maxUnchoked - 1 : this.maxUnchoked;
        const topPeers = sortedPeers.slice(0, regularSlotCount);
        const topPeerSet = new Set(topPeers);

        if (this.optimisticPeer) {
            topPeerSet.add(this.optimisticPeer);
        }

        // Reconcile across ALL peers in the pool with state-change guards
        for (const [peerKey, peer] of this.pool.getAllPeers().entries()) {
            const shouldBeUnchoked = topPeerSet.has(peer);
            const isCurrentlyChoked = peer.remotePeerState.amChoking;

            // Only issue commands if state needs to change
            if (shouldBeUnchoked && isCurrentlyChoked) {
                this.pool.unchokePeer(peerKey);
            } else if (!shouldBeUnchoked && !isCurrentlyChoked) {
                this.pool.chokePeer(peerKey);
            }
        }
    }


    private runOptimisticUnchoke(): void {
        const candidates = this.pool.getInterested().filter(peer =>
            this.isPeerEligible(peer) &&
            peer.remotePeerState.amChoking && // Must currently be choked to be a candidate for optimistic unchoke
            peer !== this.optimisticPeer
        );

        if (candidates.length === 0) {
            this.optimisticPeer = null;
            return;
        }

        const randomIndex = Math.floor(Math.random() * candidates.length);
        this.optimisticPeer = candidates[randomIndex];
        this.runRegularUnchoke();
    }

    private isPeerEligible(peer: BitTorrentPeer): boolean {
        return (
            peer.lifecycleState === 'READY' &&
            peer.remotePeerState.peerInterested === true
        );
    }

    public stop(): void {
        if (this.regularTimer) clearInterval(this.regularTimer);
        if (this.optimisticTimer) clearInterval(this.optimisticTimer);
        this.regularTimer = null;
        this.optimisticTimer = null;
    }
}
