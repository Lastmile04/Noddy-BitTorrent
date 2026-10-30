// helper funtion to compress recurring zeros in ipv6 address
function optimalCompressionLength(ipArray) {
    let bestStart = 0;
    let bestLen = 0;
    let currStart = 0;
    let currLen = 0;

    for (let idx = 0; idx < ipArray.length; idx++) {
        if (ipArray[idx] === '0') {
            if (currLen === 0) currStart = idx;
            currLen += 1
        }
        else {
            // use the first longest sequence    
            if (currLen > bestLen) {
                bestStart = currStart;
                bestLen = Math.max(bestLen, currLen);
            }
            currLen = 0;
        }
    }
    // if the array ends with zero
    if (currLen > bestLen) {
        bestStart = currStart;
        bestLen = currLen;
    }

    // return the left and right part of the address
    return { left: bestStart, right: bestLen };
}


// non-compact -> bencoded list 
// compact -> raw bytes bencoded string(raw bytes)
// to prevent deduplication use set for each ip-port set
export function parseCompactPeers(family, buffer) {
    let peers = [];
    const seen = new Set();
    switch (family) {

        case 4: // 4 + 2 -> 6

            // Length validation check
            if (buffer.length % 6 !== 0) throw new Error('Peer list is not complete');

            for (let stride = 0; stride < buffer.length; stride += 6) {

                const ip = [];
                let port = 0;

                for (let offset = 0; offset < 4; offset++) {
                    ip.push(buffer.readUInt8(stride + offset));
                }

                port = buffer.readUInt16BE(stride + 4);

                // create a key and push it to seen set for deduplication
                const ipStr = ip.join('.');
                const key = `${ipStr}:${port}`;

                // if the key is not present then create add to the set and push to peers else skip
                if (!seen.has(key)) {
                    seen.add(key);
                    peers.push({ ip: ipStr, port });
                }
            }

            break;

        case 6: // 16 + 2 -> 18

            // Length validation check
            if (buffer.length % 18 !== 0) throw new Error('Peer list is not complete');

            for (let stride = 0; stride < buffer.length; stride += 18) {

                let groups = [];
                let port = 0;

                // increment offset by 2 since we need groups
                for (let offset = 0; offset < 16; offset += 2) {

                    // since ipv6 uses 16 bit groups(2bytes each)
                    let group = buffer.readUInt16BE(stride + offset);

                    //  uses converted to string and padstart to make sure the 16 bits fill properly
                    groups.push(group.toString(16).padStart(4, '0'));
                }

                port = buffer.readUInt16BE(stride + 16);

                // ip is already divied into groups that combine to create a single ipv6 address all we need to do is to
                // normalize each group by removing leading zeros and then further compressing zeros if possible
                // INFO: Array.from([string]).findIndex(char => char!== '0') can be used to implement the first part in a more ituitive way
                // TODO: have to learn and get comfortable with regex to do this in a cleaner and efficient way to solve the current problem
                // for more control I have implemented a loop instead
                const normalizedIp = groups.map((groupStr) => {
                    // do i need a group array when i am accessing th grp directly
                    let offset = 0;
                    let start = -1;

                    while (offset < groupStr.length) {
                        const val = groupStr[offset];
                        if (val !== '0') {
                            start = offset
                            break;
                        }

                        offset += 1;
                    }

                    // if complete group is of 0 
                    if (start === -1) groupStr = '0';
                    // if some leading zeros or no leading zero exist 
                    if (start > 0) groupStr = groupStr.slice(start);
                    return groupStr;

                });

                // compress the zeros further in the normalized ip array
                // the :: for further zero compression can be said to divide the array into two sides the left and right 
                const { left, right } = optimalCompressionLength(normalizedIp);

                let ipStr;

                if (right >= 2) {
                    // create left and right subarray and the join them togather with ::
                    let leftSide = normalizedIp.slice(0, left);
                    let rightSide = normalizedIp.slice(left + right, normalizedIp.length);
                    ipStr = leftSide.join(':') + '::' + rightSide.join(':');
                }
                else {
                    ipStr = normalizedIp.join(':');
                }


                const key = `${ipStr}:${port}`;

                // if the key is not present then create add to the set and push to peers else skip
                if (!seen.has(key)) {
                    seen.add(key);
                    peers.push({ ip: ipStr, port });
                }
            }

            break;

        default:
            break;
    }
    return peers;

}

// listIR is a list of dictionaries with each dictionary containing key value pair of ip and port
/** listIR structure for better visualization
 * listIR = {
  type: 'List',
  value: [
    {
      type: 'Dictionary',
      value: [
        [Buffer('ip'),   { type: 'String', value: Buffer('1.2.3.4') }],
        [Buffer('port'), { type: 'Integer', value: 6881 }]
      ]
    },
    {
      type: 'Dictionary',
      value: [
        [Buffer('ip'),   { type: 'String', value: Buffer('5.6.7.8') }],
        [Buffer('port'), { type: 'Integer', value: 6881 }]
      ]
    }
  ]
}
 */
export function parseNonCompactPeers(listNode) {
    let peers = [];

    for (const peerDict of listNode.value) {
        let ipStr = null;
        let port = null;

        for (const [keyNode, valueNode] of peerDict.value) {
            if(keyNode.type !== 'BYTE_STRING') throw new Error(' received non-compact peers do not have string as dict key'); 
            const keyStr = keyNode.value.toString('utf-8');
            if (keyStr === 'ip' && valueNode.type === 'BYTE_STRING') {
                ipStr = valueNode.value.toString('utf-8');
            } else if (keyStr === 'port' && valueNode.type === 'INTEGER') {
                port = valueNode.value;
            }
        }

        if (ipStr !== null && port !== null) {
            peers.push({ ip: ipStr, port });
        }
    }
 
    return peers;
}
