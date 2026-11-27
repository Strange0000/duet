# Duet — System Architecture

## Overview
Duet uses a **server-authoritative real-time state** model over Socket.IO with client-side clock synchronization and provider-agnostic playback adapters.

```
[Host Browser]                          [Duet Express + Socket.IO Server]                          [Guest Browser]
  ├── RoomContext.jsx                     ├── RoomStore (authoritative state)                        ├── RoomContext.jsx
  ├── ClockSync (sync:ping) ◄───────────► ├── Socket Handlers (Zod validated) ◄────────────────────► ├── ClockSync (sync:ping)
  ├── YouTubePlayer / LocalAudioPlayer    └── Search Proxy (/api/search)                             └── YouTubePlayer / LocalAudioPlayer
```

## Key Components
1. **Authoritative Room State (`server/src/stores/roomStore.js`)**:
   - Generates 6-character cryptographic room codes (`A-Z`, `2-9`) and 48-char hex session tokens.
   - Enforces a 2-participant cap and server-verified `host` vs `guest` roles.
   - Maintains monotonic `roomVersion` and a per-room `commandId` deduplication set.
   - Stores playback as an anchor (`anchorPositionMs`, `anchorServerTimeMs`, `effectiveAtServerMs`, `playbackState`).
2. **Clock Synchronization (`src/utils/clockSync.js`)**:
   - Measures round-trip time via `performance.now()` across 5 `sync:ping` samples, discards high-RTT outliers, and computes median `clockOffsetMs`.
3. **Drift Correction (`src/utils/playbackSync.js`)**:
   - `< 150ms`: no correction.
   - `150–350ms`: tolerated without seeking.
   - `350–1000ms`: seeks only after 2 consecutive measurements + 2.5s cooldown.
   - `> 1000ms`: controlled seek with 1.5s cooldown.
4. **Player Abstraction (`src/players/`)**:
   - `BasePlayer.js` defines a uniform interface implemented by `YouTubePlayer.js` (official IFrame API) and `LocalAudioPlayer.js` (Web Audio API deterministic test fixture).
5. **Social & PWA Layers**:
   - Live reactions, private room chat, song dedications, and room themes are isolated from transport logic.
   - `public/manifest.webmanifest` and `public/sw.js` cache static shell assets only.
