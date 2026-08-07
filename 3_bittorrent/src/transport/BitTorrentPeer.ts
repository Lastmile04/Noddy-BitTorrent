import EventEmitter from "node:events";
import * as net from 'net';
import { PeerConfig, PeerState } from "./types.js";

export class BitTorrentPeer extends EventEmitter {

    remotePeerSession: PeerState;
    socket: net.Socket
    peerId: Buffer
    infoHash: Buffer
    pieceLength: number
    totalLength: number

    constructor({ socket, peer, peerId, infoHash, pieceLength, totalLength }: PeerConfig) {
        super();
        this.socket = socket;
        this.peerId = peerId;
        this.infoHash = infoHash;
        this.pieceLength = pieceLength;
        this.totalLength = totalLength;

        this.remotePeerSession = {
            ip: peer.ip,
            port: peer.port,
            remotePeerId: undefined,

            amChoking: true,
            amInterested: false,
            peerChoking: true,
            peerInterested: false,

            bitfield: undefined,
            downloadRate: 0
        }

    }
}

