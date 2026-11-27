# Duet — Test Report

*Last run: 27 Nov 2026*

## Automated Test Results

### Root Test Suite (`npm test`)
- `server/tests/roomStore.test.js`: **9 passed** (room code generation, host/guest creation, 2-participant cap, host authorization checks, `commandId` idempotency & stale `roomVersion` rejection, single-advance track-end protection, room expiration cleanup)
- `server/tests/socketIntegration.test.js`: **2 passed** (`/health`, `/ready`, `/api/providers`, full two-client Socket.IO lifecycle: create, join, 3rd-client rejection, invalid code rejection, unauthorized guest play rejection, play/state broadcast, `sync:ping`, disconnect & `sessionToken` reconnect)
- `server/tests/searchService.test.js`: **2 passed** (YouTube search service: result mapping and error handling)
- `tests/syncEngine.test.js`: **3 passed** (`ClockSync` median outlier rejection, `computeExpectedPositionMs` clamping & scheduled playback, `evaluateDriftCorrection` threshold & cooldown rules)
- `tests/driftBenchmark.test.js`: **1 passed** (simulated two-client drift benchmark: median <150ms, p95 <350ms)
- **Total**: **5 test files passed, 17/17 tests passed**.

### Production Build (`npm run build`)
- `vite build`: **passed** in 5.86s (`dist/index.html`, `dist/assets/*.css`, `dist/assets/*.js`).

## Pending Manual & Physical Device Verification
- [ ] Real iPhone Safari + Android Chrome two-device physical sync test (same Wi-Fi)
- [ ] Real iPhone Safari + Android Chrome cross-network test (Wi-Fi vs. 4G/5G)
- [ ] Screen lock / app-switch foreground recovery test on physical iOS and Android
- [ ] Bluetooth headphone latency & YouTube ad-desync recovery test
- [ ] Real YouTube Data API v3 search verification (pending `YOUTUBE_API_KEY`)
