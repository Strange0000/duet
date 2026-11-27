# Duet — Deployment Guide

## Recommended Topology
- **Backend**: Render Web Service (`server/` root directory) using [render.yaml](render.yaml)
- **Frontend**: Vercel or Render Static Site (`dist/` output)
- **Room state**: In-memory only — rooms are lost on server restart. There is no Redis/Mongo adapter yet, so do not set `REDIS_URL` or `MONGODB_URI`.

## Backend Environment Variables
- `PORT=3001`
- `NODE_ENV=production`
- `CLIENT_ORIGIN=https://your-duet-frontend.example.com`
- `YOUTUBE_API_KEY=<optional YouTube Data API v3 key>`
- `ROOM_TTL_SECONDS=86400`
- `MAX_ROOM_PARTICIPANTS=2`
- `ENABLE_SPOTIFY=true`

## Frontend Environment Variables
- `VITE_API_URL=https://your-duet-backend.onrender.com`
- `VITE_SOCKET_URL=https://your-duet-backend.onrender.com`

## Health & Readiness Checks
- `GET /health` → returns `{ status: "ok", activeRooms, uptimeSec }`
- `GET /ready` → returns `{ ready: true, storage, providers }`

## Hosting Caveats
- Free-tier web services spin down after inactivity, causing 30–50s cold starts and dropping active WebSocket connections.
- In-memory room storage is ephemeral across server restarts.
