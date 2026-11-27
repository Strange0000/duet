# Duet — API & Socket.IO Documentation

## HTTP Endpoints (`server/src/index.js`)
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health, uptime, and active room count |
| `GET` | `/ready` | Storage mode and provider availability |
| `GET` | `/api/providers` | Enabled/disabled status of YouTube, Local Fixture, and Spotify |
| `GET` | `/api/rooms/:code` | Public room summary (existence, lifecycle state, participant count) |
| `GET` | `/api/search?q=...` | Unified search (YouTube Data API v3 when configured + iTunes Search API). iTunes results carry `youtubeId: null` and a 30-second `previewUrl`. |
| `GET` | `/api/youtube/video?url=...` (or `?id=...`) | Look up one YouTube video (Data API when configured, otherwise the oEmbed fallback). Without an API key the returned `durationSec` is `null` (unknown) — the client reports the real duration via `player:duration` once playback starts. |
| `GET` | `/api/youtube/resolve?title=...&artist=...` | Resolve a search result to the best matching embeddable YouTube video. Returns `{ item, configured }`; when no `YOUTUBE_API_KEY` is configured it returns `{ item: null, configured: false }`. If the daily YouTube quota is exhausted it returns HTTP 503 with `{ error: "YouTube search quota exhausted for today" }`. |

## Rate limits

- **HTTP** (`/api/*`): 120 requests per minute per IP (`express-rate-limit`).
- **Socket.IO** (per minute; the server replies `{ ok: false, code: "RATE_LIMITED", error: ... }` when exceeded):
  | Event | Limit | Keyed by |
  |---|---|---|
  | `room:create` | 10 | connection (no participant exists yet) |
  | `room:join` | 15 | connection (no participant exists yet) |
  | `chat:send` | 30 | participantId |
  | `reaction:send` | 30 | participantId |
  | `player:seek` | 10 | participantId |
  | `chat:typing` | 10 | participantId |
  The participant-keyed limiters live at server level, so reconnecting does **not** reset them.
- **YouTube Data API quota**: at most 9,000 YouTube Data API calls per calendar day (in-memory counter, resets at midnight). Past the cap, `searchYouTubeVideos` / `lookupYouTubeVideo` return `{ error: "YouTube search quota exhausted for today" }` instead of calling the API.

## Socket.IO Events (`server/src/sockets/registerSocketHandlers.js`)

### Client → Server (with `ack` callback)
- `room:create` `{ name, source, initialTracks? }` → returns `{ ok, roomCode, participantId, sessionToken, role, state }`. The host participant's socket is attached at creation.
- `room:join` `{ roomCode, name, source, sessionToken? }` → returns `{ ok, roomCode, participantId, sessionToken, role, state }`. Sending the `sessionToken` from a previous join rejoins the same participant slot (idempotent rejoin — a refresh does not hit `ROOM_FULL`). With `requireApproval` on, a first-time join instead returns `{ ok: true, pendingApproval: true, roomCode, requestId }` with **no session token**; the host is notified via `room:join-request` and the guest is admitted (or declined) via `room:join-respond`.
- `room:join-respond` `{ requestId, approve, commandId?, expectedRoomVersion? }` (host only) → approves/declines a pending join. If the guest's socket disconnected before approval, it replies `{ ok: false, code: "GUEST_DISCONNECTED", error: "Guest disconnected — ask them to rejoin" }` and no ghost participant is created.
- `room:reconnect` `{ roomCode, sessionToken }` → restores session & state
- `room:leave` / `room:close` (host only) / `room:transfer-host` (host only)
- `room:settings` `{ allowGuestQueue?, allowGuestControl?, requireApproval?, theme?, commandId?, expectedRoomVersion? }` (host only)
- `participant:update` `{ name?, source? }`
- `player:ready` `{ ready }`
- `player:status` `{ ready?, buffering?, reportedPositionMs?, driftMs?, endedTrackVersion? }` — reporting `endedTrackVersion` equal to the current `trackVersion` advances the track once (single-advance protection: a second report for the same version does not advance again).
- `player:play` / `player:pause` / `player:seek` / `player:next` / `player:previous` (host only). `player:next`, `player:previous` and `queue:clear` accept `{ commandId?, expectedRoomVersion? }` and are schema-validated.
- `player:duration` `{ durationMs, trackVersion }` — the client reports the real duration from `player.getDuration()` (15,000–43,200,000 ms). Accepted only when `trackVersion` matches the currently playing track; the server then corrects `playback.durationMs` and the current queue item's `track.durationSec`, and broadcasts the updated state.
- `queue:add` / `queue:remove` / `queue:reorder` / `queue:select` / `queue:clear` (clear is host only)
- `sync:ping` `{ clientSentAtMs, seq }`
- `sync:request` `{}`
- `chat:send` `{ text }`
- `chat:typing` `{}` — broadcast to the other participant (rate-limited, 10/min)
- `reaction:send` `{ emoji }`

### Server → Client
- `room:state`, `playback:state`, `playback:scheduled`, `queue:updated`
- `room:created`, `room:joined`, `room:closed`, `room:error`
- `room:join-request` `{ id, name, source, requestedAtMs }` (to the host when a guest asks to join a `requireApproval` room)
- `room:join-declined` `{ roomCode, error }` (to the guest when the host declines)
- `participant:joined`, `participant:left`, `participant:updated`, `connection:status`
- `sync:pong`, `chat:message`, `chat:typing`, `reaction:burst`

### Notes
- Join approval flow, exactly as implemented: the guest's `room:join` gets `{ pendingApproval: true, requestId }`; the host receives `room:join-request`; the host answers with `room:join-respond`; the guest then receives `room:joined` (approved) or `room:join-declined` (declined). There are no separate `room:join-requested` / `room:join-decision` server events.
- A disconnected **guest** is removed from the room (and their session token freed) if they do not reconnect within 60s, opening the 2nd slot again. A disconnected host is never removed this way; the host has a separate 30s grace period after which playback pauses.
- `player:duration` and the oEmbed fallback: tracks added by pasting a YouTube URL without a YouTube API key start with an unknown duration (`durationSec: null`, `durationMs: 0`); positions are not clamped until the real duration is reported.
