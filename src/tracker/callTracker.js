import { udpPeer } from "./udpTracker.js";


export async function callTracker(handler, urlObj, trackerUrl, params) {
    let result;
    const tracker = {
        hostname: urlObj.hostname,
        port: parseInt(urlObj.port) || 6969
    };

    const torrent = {
        infoHash: params.infoHash,
        peerId: params.peerId
    };

    const session = {
        uploaded: params.uploaded,
        downloaded: params.downloaded,
        left: params.left,
        event: params.event,
        numwant: params.numwant || -1,
        port: params.port // the client's listening port
    };

    // handler has a refrence of udpPeer function and after if block we use that to call the function
    if (handler === udpPeer) {
        //  the call is clean and order-independent
        result = await handler({ tracker, torrent, session });
    } else {
        result = await handler(trackerUrl, params);
    }


    return {
        peers: result.peers,
        peerStats: {
            tracker: trackerUrl,
            interval: result.interval,
            leechers: result.leechers,
            seeders: result.seeders,
            peerNum: result.peerNum
        }
    };
}
