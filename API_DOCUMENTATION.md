# Duet — API & Socket.IO Documentation

## HTTP Endpoints (`server/src/index.js`)
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health, uptime, and active room count |
| `GET` | `/ready` | Storage mode and provider availability |
| `GET` | `/api/providers` | Enabled/disabled status of YouTube, Local Fixture, and Spotify |
| `GET` | `/api/rooms/:code` | Public room summary (existence, lifecycle state, participant count) |
| `GET` | `/api/search?q=...` | Unified search (YouTube Data API v3 when configured + iTunes Search API) |

## Socket.IO Events (`server/src/sockets/registerSocketHandlers.js`)

### Client → Server (with `ack` callback)
- `room:create` `{ name, source, initialTracks? }` → returns `{ ok, roomCode, participantId, sessionToken, role, state }`
- `room:join` `{ roomCode, name, source }` → returns `{ ok, roomCode, participantId, sessionToken, role, state }`
- `room:reconnect` `{ roomCode, sessionToken }` → restores session & state
- `room:leave` / `room:close` (host only) / `room:transfer-host` (host only)
- `room:settings` `{ allowGuestQueue?, theme?, commandId?, expectedRoomVersion? }` (host only)
- `participant:update` `{ name?, source? }`
- `player:ready` `{ ready }`
- `player:status` `{ ready?, buffering?, reportedPositionMs?, driftMs?, endedTrackVersion? }`
- `player:play` / `player:pause` / `player:seek` / `player:next` / `player:previous` (host only)
- `queue:add` / `queue:remove` / `queue:reorder` / `queue:select`
- `sync:ping` `{ clientSentAtMs, seq }`
- `sync:request` `{}`
- `chat:send` `{ text }`
- `reaction:send` `{ emoji }`

### Server → Client
- `room:state`, `playback:state`, `playback:scheduled`, `queue:updated`
- `participant:joined`, `participant:left`, `participant:updated`, `connection:status`
- `sync:pong`, `chat:message`, `reaction:burst`, `room:closed`, `room:error`
