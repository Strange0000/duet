# Duet — Implementation Plan

*Created: 27 Nov 2026*

## 1. Current Baseline
- **Frontend**: React 18 + Vite 6 + Tailwind CSS v4 + Lucide Icons + HTML5 Canvas (`AudioVisualizerCanvas.jsx`).
- **Existing UI**: `LandingPage.jsx` (hero, live sync playground, trending marquee, story, FAQ, Connect dropdown), `RoomView.jsx` (currently simulated local timer, client-side role toggle, mock queue, iTunes search).
- **Baseline Build**: `npm run build` passes (`dist/` built cleanly).

## 2. Architecture & Phase Breakdown

### Phase 1–2: Real-Time Backend & Socket.IO Contract (`server/`)
- Express 4 + Socket.IO 4 + Zod + Helmet + `express-rate-limit` + `cors` + `crypto.randomBytes` room codes & session tokens.
- Authoritative in-memory room store (`server/src/stores/roomStore.js`) with optional Redis adapter readiness, 2-participant cap, server-issued host/guest credentials, reconnect tokens, host-disconnect grace period & explicit ownership transfer, and TTL room expiration cleanup.
- Full Socket.IO event contract (`room:create`, `room:join`, `room:leave`, `room:reconnect`, `room:close`, `room:transfer-host`, `player:*`, `queue:*`, `sync:ping`, `sync:request`, `participant:update`, `chat:send`, `reaction:send`, `room:theme`) with monotonic `roomVersion`, `commandId` idempotency, and Zod schema validation.

### Phase 3: Clock-Compensated Synchronization Engine (`src/utils/clockSync.js`, `src/utils/playbackSync.js`)
- Multi-sample `sync:ping` / `sync:pong` RTT measurement, outlier rejection, median clock offset estimation using `performance.now()`.
- Authoritative playback anchor (`anchorPositionMs`, `anchorServerTimeMs`, `effectiveAtServerMs`, `playbackState`, `roomVersion`).
- Drift thresholds: `<150ms` no-op, `150–350ms` gentle tolerance, `350–1000ms` consecutive-sample correction, `>1000ms` controlled seek with cooldown.
- Real telemetry tracking (RTT, clock offset, drift, correction count, buffering state).

### Phase 4–5: Player Abstraction, Local Fixture Player & Official YouTube IFrame API (`src/players/`)
- `BasePlayer.js` interface with `getCapabilities()`.
- `LocalAudioPlayer.js`: Web Audio API synthesized original ambient/melodic fixture tracks (zero external dependencies, deterministic seeking/playback for automated and local sync verification).
- `YouTubePlayer.js`: Official YouTube IFrame Player API (`https://www.youtube.com/iframe_api`), visible inline player (`playsinline: 1`), origin configuration, error handling (invalid ID, private, embed disabled `101/150`), never hiding video or obscuring native branding/controls.

### Phase 6–7: Music Search & Provider Readiness
- Backend `/api/search` proxy with YouTube Data API v3 support (when `YOUTUBE_API_KEY` is configured) + iTunes Search API attribution & metadata normalization + embeddability check.
- Spotify kept explicitly **Unavailable / Coming Soon** (`ENABLE_SPOTIFY=false`) per developer policy constraints, documented in `PROVIDER_LIMITATIONS.md`.

### Phase 8–11: Frontend Integration, Mobile UX, Shared Queue & Social Features
- `RoomContext.jsx`, `socketClient.js`, `apiClient.js`, `usePlaybackSync.js`.
- URL routing for `/room/:code` invitation links.
- Real room mode (server-authorized roles, no free role switching) vs. explicitly labeled **Demo Mode** (`K7M9P2` / local fixture).
- Mobile-first autoplay consent/activation gesture, visibility-change resync.
- Shared queue with server authority, guest suggestions / permission toggle, deduplication, single-advance on track end.
- Modular social features: live reactions, private room chat, song dedications, room themes (`Midnight`, `Aurora`, `Sunset`, `Rose`, `Ocean`, `Minimal`), session summary.

### Phase 12–16: Security, PWA, Automated Tests & Deployment
- Helmet, CORS origin allowlist, rate limiting, Zod validation, no secrets in frontend.
- `manifest.webmanifest`, service worker (`sw.js`), offline fallback notice.
- Unit & Socket.IO integration tests (`Vitest` + `Supertest` + `socket.io-client`).
- `render.yaml`, `README.md`, `ARCHITECTURE.md`, `API_DOCUMENTATION.md`, `PROVIDER_LIMITATIONS.md`, `TEST_REPORT.md`, `DEPLOYMENT.md`.
