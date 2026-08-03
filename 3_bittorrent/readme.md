# Noddy BitTorrent

A low-level BitTorrent client MVP built from scratch in Node.js without external BitTorrent libraries.

This project implements core parts of the BitTorrent ecosystem including custom bencode parsing, HTTP/UDP tracker communication, peer wire protocol handling, and SHA1 piece verification. The goal of the project is to deeply understand networking protocols, binary data handling, and event-driven system design by building the protocol stack manually.

The implementation progresses protocol-layer by protocol-layer:

- HTTP communication in Node.js
- UDP socket programming
- `.torrent` metadata parsing
- Tracker communication
- Peer discovery
- BitTorrent handshake negotiation
- Piece/block downloading and verification

---

## Demo

![NoddyBitTorrent Demo](./src/assets/demo.gif)

### Example Output

```bash
📦 Torrent metadata validated
🔑 Info hash generated
🌐 Tracker connected
👥 Peers discovered: 50
⏱ Announce interval: 900

╔══════════════════════════════════════════════════════════╗
║                🚀 NODDY BITTORRENT                      ║
║           BitTorrent Protocol Implementation            ║
╚══════════════════════════════════════════════════════════╝

📍 Target: debian-13.3.0-amd64-netinst.iso

❌ 193.32.249.228:51413 — Handshake timeout
❌ 217.155.0.164:42069 — Host unreachable
✅ Connected Peer: 217.138.216.169:50495

⬇️ Downloading Piece #0
📊 [■■■■■■■■■■■■■■■■] 100%

✅ Piece #0 verified successfully
🔐 SHA1 integrity check passed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📥 DOWNLOAD SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 Torrent:            debian-13.3.0-amd64-netinst.iso
👥 Peers Contacted:    3
✅ Successful Peers:   1
❌ Failed Peers:       2
🔐 Integrity Check:    PASSED (SHA1)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Features

### Torrent & Metadata Handling
- Custom bencode parser and validator
- SHA1 info-hash generation
- Torrent metadata extraction

### Tracker Protocols
- HTTP tracker implementation
- UDP tracker implementation
- Compact and non-compact peer parsing
- IPv4 and IPv6 peer support

### Peer Wire Protocol
- TCP peer communication
- BitTorrent handshake implementation
- Bitfield and HAVE message handling
- Interested / unchoke flow
- Piece/block request pipeline

### Reliability & Validation
- Retry and timeout handling
- Incremental TCP stream parsing
- Piece SHA1 verification
- Defensive protocol validation

### CLI & Observability
- Stateful terminal peer dashboard
- Live peer connection visualization
- Download summaries and integrity reporting

---

## Protocol Flow

```txt
.torrent file
      ↓
Bencode Parsing
      ↓
Info Hash Generation
      ↓
Tracker Communication
      ↓
Peer Discovery
      ↓
TCP Peer Connection
      ↓
BitTorrent Handshake
      ↓
Bitfield Negotiation
      ↓
Interested / Unchoke
      ↓
Block Downloading
      ↓
SHA1 Piece Verification
```

---

## Download Lifecycle

### 1. Torrent Parsing

The client reads the `.torrent` file, validates the bencode structure,
extracts the raw `info` dictionary bytes, and computes the SHA1 info-hash
used for tracker and peer identification.

### 2. Tracker Communication

The client builds BitTorrent announce requests and communicates with
trackers using both HTTP and UDP tracker protocols. Tracker responses
are validated, decoded, and normalized into a unified peer representation
used by the transport layer.

### 3. Peer Discovery

Peers returned by trackers are parsed from compact and non-compact formats,
supporting both IPv4 and IPv6 peer addresses. The discovery layer also
handles peer deduplication before peers are passed to the connection stage.

### 4. TCP Peer Connection

Peers returned by the tracker are contacted sequentially. The client
attempts to establish a TCP connection and applies timeout handling
to avoid hanging on unreachable peers.

### 5. BitTorrent Handshake

After establishing a TCP connection, the client performs the BitTorrent
handshake by exchanging protocol identifiers, reserved bytes, info-hashes,
and peer IDs. The received info-hash is validated to ensure both peers
are communicating about the same torrent.

### 6. Bitfield Negotiation

Peers advertise available pieces using `BITFIELD` and `HAVE` messages.
The client analyzes peer piece availability to determine which pieces
can be requested from the remote peer.

### 7. Interested / Unchoke Flow

Once a valid downloadable piece is identified, the client sends an
`INTERESTED` message to the peer. Block requests are only sent after
the remote peer responds with an `UNCHOKE` message.

### 8. Block Downloading

After receiving an `UNCHOKE` message, the client requests fixed-size
blocks from the selected piece. Incoming TCP data is buffered and parsed
incrementally to handle fragmented peer-wire messages correctly.

### 9. SHA1 Piece Verification

After all blocks for a piece are downloaded, the client computes the
SHA1 hash of the reconstructed piece buffer and compares it against the
expected hash stored inside the torrent metadata. This guarantees piece
integrity and prevents corrupted or malicious data from being accepted.

---

## Architecture

```txt
src/
├── app/           # Application orchestration
├── codec/         # Bencode parser/validator
├── identity/      # SHA1 hashing and peer identity
├── peers/         # Peer parsing utilities
├── tracker/       # HTTP/UDP tracker communication
├── transport/     # Peer wire protocol implementation
└── presentation/  # CLI rendering and status dashboard
```

---

## Key Engineering Challenges

### Incremental TCP Stream Parsing

Peer-wire messages may arrive fragmented across multiple TCP packets.
The transport layer buffers incoming data incrementally and only parses
messages once sufficient bytes have been received.

### Handling Unreliable Peers

Many peers returned by trackers are unreachable, timeout, or terminate
connections unexpectedly. The client implements retry and timeout handling
to survive unreliable distributed network behavior.

### Protocol Validation

Tracker responses, handshakes, and peer-wire messages are validated
defensively to prevent malformed protocol data from propagating through
higher layers of the application.

### Asynchronous State Coordination

The project heavily relies on event-driven architecture and asynchronous
network communication. Coordinating peer states, timeouts, retries,
downloads, and CLI rendering required careful separation of concerns.

### Terminal Rendering Synchronization

The CLI dashboard evolved into a state-driven renderer responsible for
displaying peer lifecycle updates, progress visualization, and integrity
verification while avoiding terminal corruption caused by concurrent writes.

---

## Design Philosophy

This project prioritizes protocol correctness, observability,
and architectural clarity over download throughput or feature
completeness.

The primary focus of the MVP is understanding how the BitTorrent
ecosystem works internally by implementing networking layers manually
instead of relying on existing BitTorrent libraries.

---

## Current Limitations

This project is currently an MVP focused on protocol correctness,
networking fundamentals, and understanding the BitTorrent ecosystem
internally rather than maximizing download throughput.

Current limitations include:

- Sequential peer connection attempts
- Single-piece downloading
- No rarest-first piece selection strategy
- No request pipelining
- No upload/seeding support
- No persistent file writing to disk
- No magnet link support
- No DHT (Distributed Hash Table) support
- No Peer Exchange (PEX)
- Limited peer state management
- CLI currently optimized for debugging/demo usage

These tradeoffs were intentionally made to simplify debugging and
validate protocol behavior incrementally while building the client
layer-by-layer.

---

## What I Learned

Building this project provided hands-on experience with:

### Networking & Protocols
- TCP and UDP socket programming in Node.js
- Binary protocol parsing and serialization
- HTTP and UDP tracker protocol behavior
- BitTorrent peer wire protocol lifecycle
- Stateful peer communication

### Systems Programming Concepts
- Event-driven architecture
- Incremental TCP stream parsing
- Buffer management and binary data handling
- Retry and timeout strategies
- Protocol validation and defensive parsing
- State synchronization in asynchronous systems

### BitTorrent Internals
- Torrent metadata structure
- SHA1 info-hash generation
- Peer discovery workflows
- Bitfield negotiation
- Piece/block request flow
- Piece integrity verification

### Engineering & Architecture
- Layered system design
- Separation of transport and presentation logic
- CLI observability and protocol visualization
- Handling unreliable distributed systems gracefully

---

## How To Run

### Prerequisites

- Node.js v18+
- A `.torrent` file

### Clone Repository

```bash
git clone <your-repository-url>
cd bittorrent_from_scratch/3_bittorrent
```

### Install Dependencies

```bash
npm install
```

### Configure Torrent File

Place a `.torrent` file inside the `samples/` directory and update
the path inside:

```txt
src/app/main.js
```

### Run Client

```bash
node src/app/main.js
```

---

## Roadmap

### Core BitTorrent Features
- Parallel peer connection racing
- Multi-piece downloading
- Request pipelining
- Rarest-first piece selection
- Endgame mode
- Persistent file storage

### Network Features
- Upload/seeding support
- Magnet link support
- DHT support
- Peer Exchange (PEX)
- Tracker tier fallback improvements
- Better peer choking/unchoking strategies

### Performance & Reliability
- Buffer pooling
- Smarter retry strategies
- Peer reputation handling
- Download scheduling improvements
- Memory usage optimization

### CLI & Tooling
- Richer terminal dashboard
- Transfer statistics and speed monitoring
- Verbose/debug logging modes
- Better progress visualization
- Interactive torrent selection

---

## References

- BEP 3 — BitTorrent Protocol Specification
- BEP 15 — UDP Tracker Protocol
- Node.js `net` module documentation
- Node.js `dgram` module documentation

---

## Disclaimer

This project was built for educational purposes to understand how the
BitTorrent ecosystem works internally. Please use responsibly and only
download/share content you legally have the right to access.

---

## Project Completion Roadmap

v0.1
 |
 |-- AST/grammar cleanup
 |
v0.2
 |
 |-- Download all pieces
 |-- Verify SHA1
 |-- Write disk
 |
v0.3
 |
 |-- Multiple peer connections
 |-- Concurrent requests
 |
v0.4
 |
 |-- Extract piece manager interface
 |
v0.5
 |
 |-- Rewrite piece manager as Go service
 |
v1.0
 |
 |-- Resume
 |-- TUI
 |-- Magnet links
