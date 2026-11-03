# Noddy BitTorrent

A low-level BitTorrent client built from scratch in **Node.js and TypeScript**. Noddy implements torrent metadata parsing, HTTP and UDP tracker communication, the TCP peer-wire protocol, concurrent swarm downloads, uploading and seeding, and SHA-1 piece integrity verification.

## Overview

Noddy BitTorrent is an educational project developed to understand the inner workings of peer-to-peer file sharing and distributed network systems.

Rather than relying on existing BitTorrent libraries, Noddy implements core protocol primitives manually — from recursive binary bencode parsing and stream-framed TCP message handling to storage pre-allocation and peer state management.

## Features

### Torrent Metadata

- Custom bencode decoder and encoder.
- Torrent metadata validation.
- Raw `info` dictionary extraction for accurate info-hash calculation.
- SHA-1 info-hash generation.
- Peer ID generation.

### Tracker Communication

- HTTP tracker support.
- UDP tracker support (BEP 15).
- Tracker tier handling and fallback.
- Compact and non-compact peer response parsing.
- IPv4 and IPv6 peer address support.
- Transaction ID validation and retry handling.

### Peer Communication

- TCP peer connections.
- BitTorrent handshake implementation.
- Info-hash and protocol validation.
- Peer-wire message parsing and serialization.
- Support for `BITFIELD`, `HAVE`, `INTERESTED`, `NOT_INTERESTED`, `CHOKE`, `UNCHOKE`, `REQUEST`, `PIECE`, and `CANCEL` messages.
- Peer interest and choking state management.

### Download and Upload

- Concurrent block downloads from multiple peers.
- Piece and block scheduling.
- SHA-1 piece integrity verification.
- Upload support.
- Disk pre-allocation.
- Disk-space checks and recovery handling.

### CLI

- Interactive torrent and download path selection.
- Terminal download progress display.
- Download speed and peer statistics.
- Session summary.
- Graceful shutdown on `SIGINT`.

## How It Works

A simplified view of the download lifecycle:

1. Parse and validate the `.torrent` file.
2. Extract the raw `info` dictionary and calculate its SHA-1 hash.
3. Generate the client peer ID.
4. Contact trackers to discover peers.
5. Establish TCP connections with discovered peers.
6. Complete the BitTorrent handshake.
7. Exchange peer availability and state information.
8. Schedule and request missing blocks.
9. Assemble blocks into pieces and verify their SHA-1 hashes.
10. Write verified pieces to disk.

## Technology Stack

| Technology | Purpose |
|---|---|
| Node.js | Runtime and networking |
| TypeScript | Application implementation |
| TCP (`node:net`) | Peer communication |
| UDP (`node:dgram`) | UDP tracker communication |
| HTTP | HTTP tracker communication |
| SHA-1 | Info-hash and piece verification |
| Node.js filesystem APIs | File storage and pre-allocation |

## Project Structure

```text
.
├── samples/
├── downloads/
├── src/
│   ├── app/
│   ├── codec/
│   ├── identity/
│   ├── tracker/
│   ├── peers/
│   ├── transport/
│   ├── download/
│   ├── errors/
├── package.json
├── tsconfig.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18 or later.
- npm.
- A `.torrent` file.

### Installation

Clone the repository:

```bash
git clone <repository-url>
cd <repository-directory>
```

Install dependencies:

```bash
npm install
```

### Running

Start the client:

```bash
npm run dev
```

Alternatively, run the application entry point directly:

```bash
npx tsx src/app/main.ts
```

Follow the interactive prompts to select a torrent file and download location.

## Performance and Testing

Noddy has been tested against both public and local BitTorrent swarms.

### Public Swarm Test

Noddy was tested against a public BitTorrent swarm using the Debian 13.3.0 amd64 netinst ISO.

- The download was performed incrementally, with data received across multiple sessions.
- Average download speeds were generally below 1 MB/s.
- Occasional speed peaks reached approximately 5–6 MB/s.
- SHA-1 piece integrity verification was used to validate downloaded pieces.

Download speed varied during testing depending on peer availability and swarm conditions. No controlled benchmark was performed.

### Local Swarm Test

Tested with one seeder and three leechers.

- Peers successfully connected.
- Pieces were transferred between clients.
- SHA-1 piece integrity verification passed.

## Limitations

The current implementation does not support:

- Distributed Hash Table (DHT).
- Peer Exchange (PEX).
- Magnet links and metadata exchange.
- Resume support for interrupted downloads.
- Advanced choking and peer-selection strategies.

## Future Scope

Potential improvements include:

- DHT support (BEP 5).
- Peer Exchange (BEP 11).
- Magnet link support and metadata exchange (BEP 9).
- Improved choking and tit-for-tat strategies.
- Resume support for interrupted downloads.
- More comprehensive protocol and integration tests.
- Performance profiling and optimization.

## References

- [BitTorrent Protocol Specification](https://www.bittorrent.org/beps/bep_0003.html)
- [BEP 5 — DHT Protocol](https://www.bittorrent.org/beps/bep_0005.html)
- [BEP 9 — Extension for Peers to Send Metadata Files](https://www.bittorrent.org/beps/bep_0009.html)
- [BEP 11 — Peer Exchange](https://www.bittorrent.org/beps/bep_0011.html)
- [BEP 15 — UDP Tracker Protocol](https://www.bittorrent.org/beps/bep_0015.html)

## License

This project is licensed under the MIT License.

## Disclaimer

Noddy BitTorrent is an educational implementation intended to explore the BitTorrent protocol and peer-to-peer networking. It is not intended to replace mature, production-grade BitTorrent clients.
