import * as net from 'net';
import { Peer } from '../peers/types.js';

export interface PeerConfig {
    socket: net.Socket
    pstr: string
    peer: Peer
    peerId: Buffer
    infoHash: Buffer
    pieceLength: number
    totalLength: number
}


