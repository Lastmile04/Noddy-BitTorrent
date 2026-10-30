import { callTracker } from "./callTracker.js";
import { httpPeers } from "./httpTracker.js";
import { udpPeer } from "./udpTracker.js";

// BASE SETUP
// input params at the initiation of function
// get loop through each tier
// get the tracker inside each tier 
// figure out the protocol of  the tracker 
// send the tracker to it's respective function
// if you get success from one tier stop the operation and do not try other tiers
// get the all the peers inside a single array

// NOTE: Because of this project currently an MVP, so only single trackerUrl which gives peers is immedeatly extrcted instead of accumulating all the peers based on the tiers. In future version I might add multiple peers and fallback; 

// NOTE: announceList is just a list of lists with each list being a different tier and each tier containing certain string addresses (no valueIR, that has already been taken care of inside the getAnnounce funtion)
export async function urlDispatcher(announceList, params) {

    // a helper dictionary for handling protocols
    const protocolHandler = {
        'udp:': udpPeer,
        'http:': httpPeers,
        'https:': httpPeers
    }

    // loop through each tier
    for (let tier = 0; tier < announceList.length; tier++) {

        // loop through each url inside that tier
        for (let trackerIdx = 0; trackerIdx < announceList[tier].length; trackerIdx++) {
            let trackerUrl = "";
            try {
                trackerUrl = announceList[tier][trackerIdx];
                // use URL constructor to get the url object to get the protocol for classification
                const urlObj = new URL(trackerUrl);
                const handler = protocolHandler[urlObj.protocol];

                if (handler) {
                    const res = await callTracker(handler, urlObj, trackerUrl, params);
                    if (res.peers && res.peers.length) return res;
                }


            } catch (e) {
                console.warn(`Tracker failed: ${trackerUrl}`, e.message);
            }
        }
    }
    return { peers: [], peerStats }
}
