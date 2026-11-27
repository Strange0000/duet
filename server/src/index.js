import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as SocketIOServer } from 'socket.io';
import { env } from './config/env.js';
import { RoomStore } from './stores/roomStore.js';
import { registerSocketHandlers } from './sockets/registerSocketHandlers.js';
import { unifiedSearch, lookupYouTubeVideo } from './services/searchService.js';

export function createApp({ store: customStore } = {}) {
  const app = express();
  const server = http.createServer(app);

  const store =
    customStore ||
    new RoomStore({
      ttlMs: env.ROOM_TTL_SECONDS * 1000,
      maxParticipants: env.MAX_ROOM_PARTICIPANTS,
      hostGraceMs: env.HOST_GRACE_MS,
    });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || env.ALLOWED_ORIGINS.includes(origin) || env.ALLOWED_ORIGINS.includes('*')) {
          return cb(null, true);
        }
        return cb(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '64kb' }));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', apiLimiter);

  // Health & Readiness endpoints
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'duet-server',
      uptimeSec: Math.round(process.uptime()),
      activeRooms: store.rooms.size,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', (_req, res) => {
    res.json({
      ready: true,
      storage: env.REDIS_URL ? 'redis-configured' : 'in-memory',
      providers: {
        youtube: true,
        youtubeSearchApi: Boolean(env.YOUTUBE_API_KEY),
        localFixture: true,
        spotify: env.ENABLE_SPOTIFY,
      },
    });
  });

  app.get('/api/providers', (_req, res) => {
    res.json({
      youtube: {
        available: true,
        searchApiConfigured: Boolean(env.YOUTUBE_API_KEY),
        note: 'Official YouTube IFrame Player API',
      },
      local: {
        available: true,
        note: 'Built-in synthesized audio fixture for deterministic sync testing',
      },
      spotify: {
        available: env.ENABLE_SPOTIFY,
        reason: env.ENABLE_SPOTIFY
          ? 'Enabled'
          : 'Unavailable pending Spotify developer policy authorization and OAuth setup.',
      },
    });
  });

  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 200) {
      return res.status(400).json({ error: 'Query parameter q (1–200 chars) is required' });
    }
    try {
      const result = await unifiedSearch(q);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'Music search failed', detail: err.message });
    }
  });

  app.get('/api/youtube/video', async (req, res) => {
    const input = String(req.query.url || req.query.id || '').trim();
    if (!input || input.length > 200) {
      return res.status(400).json({ error: 'YouTube url or id parameter is required' });
    }
    try {
      const result = await lookupYouTubeVideo(input);
      if (result.error) {
        return res.status(404).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'YouTube lookup failed', detail: err.message });
    }
  });

  app.get('/api/rooms/:code', (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const room = store.getRoom(code);
    if (!room) {
      return res.status(404).json({ error: 'Room not found or expired' });
    }
    const serialized = store.serializeRoom(room);
    res.json({
      roomCode: serialized.roomCode,
      lifecycleState: serialized.lifecycleState,
      participantCount: serialized.participants.length,
      maxParticipants: store.maxParticipants,
    });
  });

  const io = new SocketIOServer(server, {
    cors: {
      origin: env.ALLOWED_ORIGINS.includes('*') ? '*' : env.ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    maxHttpBufferSize: 64 * 1024,
  });

  registerSocketHandlers(io, store, env);

  const cleanupInterval = setInterval(() => {
    store.cleanupExpired();
  }, 60 * 1000);
  cleanupInterval.unref?.();

  return { app, server, io, store, cleanupInterval };
}

// Start server when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { server, io, cleanupInterval } = createApp();
  server.listen(env.PORT, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'Duet backend listening',
        port: env.PORT,
        origins: env.ALLOWED_ORIGINS,
        spotifyEnabled: env.ENABLE_SPOTIFY,
        youtubeApiConfigured: Boolean(env.YOUTUBE_API_KEY),
      })
    );
  });

  const shutdown = () => {
    clearInterval(cleanupInterval);
    io.close(() => {
      server.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
