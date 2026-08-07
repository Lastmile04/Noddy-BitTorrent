import * as net from 'net';
import { Peer } from '../peers/types.js';

export interface PeerConfig {
    socket: net.Socket
    peer: Peer
    peerId: Buffer
    infoHash: Buffer
    pieceLength: number
    totalLength: number
}

export interface PeerState {
    // Connection info
    ip: string;
    port: number;
    remotePeerId?: Buffer; // Set after handshake

    // Protocol State Machine
    amChoking: boolean;       // Default: true
    amInterested: boolean;     // Default: false
    peerChoking: boolean;     // Default: true
    peerInterested: boolean;   // Default: false

    // Bitfield & Metrics
    bitfield?: Buffer;
    downloadRate: number;
}
