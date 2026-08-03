import { percentEncode } from './encode.js';
import http from 'http';
import https from 'https';
import { Buffer } from 'buffer';
import { decode } from "../codec/parser.ts";
import zlib from 'zlib';
import { parseCompactPeers } from "../peers/peerParser.js";
import { parseNonCompactPeers } from "../peers/peerParser.js";
//import { validateBencode } from "../codec/validator.js";

// decode from parser.ts
export async function httpPeers(trackerUrl, paramsObj) {

    const url = buildAnnounce(trackerUrl, paramsObj);
    console.log("HTTP_ANNOUNCE_URL: ", url);
    const buf = await fetchTracker(url);
    console.log('TRACKER_BUF: ', buf);

    //validateBencode(buffer);
    const decoded = decode(buf, 0);
    console.log("DECODED_TRACKER: ", decoded);
    if (decoded.type !== 'DICT') throw new Error('Response is not a dictionary');
    return normalizeTracker(decoded.value);
}


function buildAnnounce(baseUrl, urlObj) {
    let params = [];

    params.push(`info_hash=${percentEncode(urlObj.infoHash)}`);
    params.push(`peer_id=${percentEncode(urlObj.peerId)}`);
    params.push(`port=${urlObj.port}`);
    params.push(`uploaded=${urlObj.uploaded ?? 0}`);
    params.push(`downloaded=${urlObj.downloaded ?? 0}`);
    params.push(`left=${urlObj.left}`);
    params.push(`compact=1`);
    params.push(`numwant=${urlObj.numwant ?? 50}`);

    if (urlObj.event) params.push(urlObj.event);
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}${params.join('&')}`;
}

async function fetchTracker(url) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const client = urlObj.protocol === 'https:' ? https : http;
        // Since this support gzip handling
        const req = client.get(
            urlObj, {
            headers: { 'Accept-Encoding': 'gzip' }
        },
            (res) => {
                const encoding = res.headers['content-encoding'];
                if (res.statusCode !== 200) {
                    reject(new Error(`Tracker returned: ${res.statusCode}`));
                    res.resume();
                    return
                }
                let chunks = [];
                // event listener
                res.on('data', chunk => chunks.push(chunk));

                res.on('end', () => {
                    const rawBuffer = Buffer.concat(chunks);
                    let finalBuffer = rawBuffer;  // Default: uncompressed

                    //   Just in case node lowercases header keys and HTTP is case sensitive the safe option is to include toLowerCase
                    if (encoding && encoding.toLowerCase().includes('gzip')) {
                        // since gzip can throw, use try and catch
                        try {
                            finalBuffer = zlib.gunzipSync(rawBuffer);
                        } catch (error) {
                            reject(new Error('Invalid gzip response from tracker'));
                            return;
                        }
                    }
                    console.log("FINAL_BUF: ", finalBuffer);
                    resolve(finalBuffer);  // Always resolves the right buffer
                });

            });

        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error(`Tracker timeout`));
        });

        req.on('error', reject);
        req.end();
    })
}


function normalizeTracker(response) {

    // Phase 2: Extract fields
    let interval = 0;
    let compact4 = null;   // peers  → IPv4 compact binary
    let compact6 = null;   // peers6 → IPv6 compact binary
    let nonCompact = null;  // peers  → non-compact list of dicts
    let seeders = 0;
    let leechers = 0;

    for (const [keyNode, valueNode] of response) {
        if (keyNode.type !== 'BYTE_STRING') throw new Error("tracker response key is not a byte string");
        const key = keyNode.value.toString('utf8');
        const type = valueNode.type;
        const value = valueNode.value;

        switch (key) {
            // phase 1: throw error first thing after checking for failure reason key
            case 'failure reason':
                throw new Error(`Tracker failure: ${value.toString('utf-8')}`);  // ← first case, throws immediately

            case 'interval':
                if (type !== 'INTEGER') throw new Error('interval must be Integer');
                interval = value;
                break;

            case 'peers':

                if (type !== 'BYTE_STRING' && type !== 'LIST') throw new Error(`Malformed peers do not match correct type:${type}`);
                if (type === 'BYTE_STRING') compact4 = value; // compact IPv4
                if (type === 'LIST') nonCompact = value; // non-compact contains both IPv4 and IPv6
                break;

            case 'peers6':
                if (type !== 'BYTE_STRING') throw new Error(`Malformed peers do not match correct type:${value}`);
                else compact6 = value; // compact IPv6
                break;

            case 'complete':
                if (type !== 'INTEGER') throw new Error('complete must be Integer');
                seeders = value;
                break;

            case 'incomplete':
                if (type !== 'INTEGER') throw new Error('incomplete must be Integer');
                leechers = value;
                break;

            default: break;
        }
    }

    // Phase 3: Validate required fields
    if (!interval || interval <= 0) throw new Error('Invalid or missing interval');

    let peers = [];
    // length check just to make sure that some string exists in the buffer since for js empty buffer is still a truthy and valid value
    if (compact4 && compact4.length > 0) peers.push(...parseCompactPeers(4, compact4));
    if (compact6 && compact6.length > 0) peers.push(...parseCompactPeers(6, compact6));
    if (nonCompact && nonCompact.length > 0) peers.push(...parseNonCompactPeers(nonCompact));

    console.log("INTERVAL: ", interval);
    console.log("SEEDERS: ", seeders);
    console.log("LEECHERS: ", leechers);
    console.log("PEERS: ", peers);

    return { interval, seeders, leechers, peers, peerNum: peers.length }
}
