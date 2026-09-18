import EventEmitter from "node:events";

type PieceToPeersMap = Map<number, Set<string>>;

export class PieceSelector extends EventEmitter {

    pieceCount: number;
    availabilityArray: number[];
    pieceToPeersMap: PieceToPeersMap;

    constructor(pieceCount: number) {
        super();
        this.pieceCount = pieceCount;
        this.availabilityArray = new Array(pieceCount);
        this.pieceToPeersMap = new Map();
    }

    public select(needed: number[], setSize: number): number[] { }

    public getSources(pieces: number[]): PieceToPeersMap { };

    public updatePieceToPeersMap(key: string, data: number | Buffer): void { };

    public removePeer(key: string): void { };
}
