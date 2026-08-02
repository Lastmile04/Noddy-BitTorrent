import { percentEncode } from "./encode.js";
import http from 'http';
import https from 'https';
import { Buffer } from 'buffer';
import { decode } from "../codec/parser.ts";
import zlib from 'zlib';
import { parseCompactPeers } from "../peers/peerParser.js";
import { parseNonCompactPeers } from "../peers/peerParser.js";
import { validateBencode } from "../codec/validator.js";

// decode from bencode.js
export async function httpPeers(trackerUrl, paramsObj) {

    const url = buildAnnounce(trackerUrl, paramsObj);
    const buffer = await fetchTracker(url);

    // validate raw buffer first, then decode
    validateBencode(buffer);
    const decoded = decode(buffer, 0);
    if (decoded.type !== 'DICT') throw new Error('Response is not a dictionary');

    return normalizeTracker(decoded.value);
}


function buildAnnounce(baseUrl, urlObj) {
    let params = [];

    params.push(percentEncode(urlObj.infoHash));
    params.push(percentEncode(urlObj.peerId));
    params.push(urlObj.port);
    params.push(urlObj.uploaded ?? 0);
    params.push(urlObj.downloaded ?? 0);
    params.push(urlObj.left);
    params.push(1);
    params.push(urlObj.numwant ?? 50);

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

    for (const [keyBuffer, valueIR] of response) {

        const key = keyBuffer.toString('utf8');
        const type = valueIR.type;
        const value = valueIR.value;

        switch (key) {
            // phase 1: throw error first thing after checking for failure reason key
            case 'failure reason':
                throw new Error(`Tracker failure: ${value.toString('utf-8')}`);  // ← first case, throws immediately

            case 'interval':
                if (type !== 'Integer') throw new Error('interval must be Integer');
                interval = value;
                break;

            case 'peers':

                if (type !== 'String' && type !== 'List') throw new Error(`Malformed peers do not match correct type:${type}`);
                if (type === 'String') compact4 = value; // compact IPv4
                if (type === 'List') nonCompact = value; // non-compact contains both IPv4 and IPv6
                break;

            case 'peers6':
                if (type !== 'String') throw new Error(`Malformed peers do not match correct type:${valueIR.value}`);
                else compact6 = value; // compact IPv6
                break;

            case 'complete':
                if (type !== 'Integer') throw new Error('complete must be Integer');
                seeders = value;
                break;

            case 'incomplete':
                if (type !== 'Integer') throw new Error('incomplete must be Integer');
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


    return { interval, seeders, leechers, peers, peerNum: peers.length }
}

