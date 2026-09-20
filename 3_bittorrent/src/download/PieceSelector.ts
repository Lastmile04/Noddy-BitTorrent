import EventEmitter from "node:events";

export class PieceSelector extends EventEmitter {

    public readonly pieceCount: number;
    public readonly availabilityArray: Uint16Array;
    public readonly pieceToPeersMap: Map<number, Set<string>>;

    constructor(pieceCount: number) {
        super();
        this.pieceCount = pieceCount;
        this.availabilityArray = new Uint16Array(pieceCount);
        this.pieceToPeersMap = new Map();
    }

    public updatePieceToPeersMap(key: string, data: number | Buffer): void {
        if (typeof data === 'number') this.handleHave(key, data);
        else if (Buffer.isBuffer(data)) this.handleBitfield(key, data);
    };

    private handleHave(peerKey: string, pieceIdx: number): void {
        if (pieceIdx < 0 || pieceIdx >= this.pieceCount) return;

        let peerSet = this.pieceToPeersMap.get(pieceIdx);
        if (!peerSet) {
            peerSet = new Set();
            this.pieceToPeersMap.set(pieceIdx, peerSet);
        }

        if (!peerSet.has(peerKey)) {
            peerSet.add(peerKey);
            this.availabilityArray[pieceIdx] = peerSet.size;
        }
    };

    private handleBitfield(peerKey: string, bitfield: Buffer): void {
        for (let i = 0; i < this.pieceCount; i++) {
            const byteIdx = Math.floor(i / 8);
            const bitIdx = 7 - (i % 8);

            if (byteIdx < bitfield.length && (bitfield[byteIdx] & (1 << bitIdx))) {
                this.handleHave(peerKey, i);
            }
        }
    }

    public select(needed: number[], setSize: number): number[] {
        // Filter candidates that actually have at least one available peer
        const candidates = needed.filter(
            (index) => index >= 0 && index < this.pieceCount && this.availabilityArray[index] > 0
        );

        if (candidates.length === 0) return [];

        // Sort: Primary = Rarest First (Ascending), Secondary = Piece Index (Ascending)
        candidates.sort((a, b) => {
            const rarityA = this.availabilityArray[a];
            const rarityB = this.availabilityArray[b];

            if (rarityA !== rarityB) {
                return rarityA - rarityB; // Rarest first
            }

            return a - b; // Deterministic tie-breaker
        });

        // Take working set ceiling
        return candidates.slice(0, setSize);
    }

    public getSources(pieces: number[]): Map<number, Set<string>> {
        const result = new Map<number, Set<string>>();

        for (const pieceIndex of pieces) {
            const sources = this.pieceToPeersMap.get(pieceIndex);
            if (sources && sources.size > 0) {
                result.set(pieceIndex, new Set(sources));
            }
        }

        return result;
    };


    public removePeer(peerKey: string): void {
        for (const [pieceIdx, peerSet] of this.pieceToPeersMap.entries()) {
            if (peerSet.delete(peerKey)) {
                if (peerSet.size === 0) {
                    this.pieceToPeersMap.delete(pieceIdx);
                    this.availabilityArray[pieceIdx] = 0;
                } else {
                    this.availabilityArray[pieceIdx] = peerSet.size;
                }
            }
        };
    };
}
