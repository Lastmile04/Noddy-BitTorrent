import * as net from 'net';
import { Peer } from '../peers/types.js';

export interface PeerConfig {
    socket: net.Socket
    peer: Peer
    peerId: Buffer
    infoHash: Buffer
    pieceLength: number
    totalLength: number
    pieceCount: number
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

export interface HandshakeResult {
    bytesConsumed: number;    // How many bytes to slice off the buffer queue (68 for standard)
    pstr: string;             // Protocol string name
    reserved: Buffer;         // 8-byte extension support flags (BEP 10 extension protocol, DHT, etc.)
    infoHash: Buffer;         // 20-byte Torrent InfoHash
    peerId: Buffer;           // 20-byte Remote Peer ID
}

export interface PeerMessage {
    type: string;
    id?: number;
    pieceIndex?: number;
    bitfield?: Buffer;
    index?: number;
    begin?: number;
    length?: number;
    block?: Buffer;
}

export interface RequestState {
    index: number;
    begin: number;
    length: number;
    requestedAt: number;
}

// protocols.ts - Extracted configuration and constraints
export const BT_PROTOCOL_LEN = 19;
const BT_PROTOCOL_STR = "BitTorrent protocol" as const;

// Read-only byte representation pre-allocated to avoid on-the-fly encoding costs
export const BT_PROTOCOL_BUFFER = Buffer.from(BT_PROTOCOL_STR, 'ascii');



