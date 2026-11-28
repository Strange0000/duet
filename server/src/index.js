import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as SocketIOServer } from 'socket.io';
import { env } from './config/env.js';
import { RoomStore } from './stores/roomStore.js';
import { registerSocketHandlers } from './sockets/registerSocketHandlers.js';
import { unifiedSearch, lookupYouTubeVideo, resolveYouTubeTrack } from './services/searchService.js';

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
        // E-05/I-06: use the centralized allow-list check that also covers
        // Netlify branch deploy previews (e.g. some-feature--duet-music.netlify.app).
        if (env.isAllowedOrigin(origin)) {
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
      storage: 'in-memory',
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

  // N-01: resolve an iTunes search result (title + artist) to the best
  // matching embeddable YouTube video. When no YOUTUBE_API_KEY is configured
  // this honestly returns { item: null, configured: false } — no scraping,
  // no fabricated video IDs.
  app.get('/api/youtube/resolve', async (req, res) => {
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    if (!title || title.length > 200 || artist.length > 200) {
      return res.status(400).json({ error: 'Query parameter title (1–200 chars) is required' });
    }
    try {
      const result = await resolveYouTubeTrack(title, artist);
      if (result.error) {
        return res.status(503).json({ item: null, configured: true, error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'YouTube resolve failed', detail: err.message });
    }
  });

  // Pre-join room summary. This is intentionally public: the 6-character
  // room code is the secret (about 1 billion combinations), and /api/ is
  // rate-limited, so it cannot be used to enumerate live rooms at scale.
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
      // E-05/I-06: use the same centralized origin check for Socket.IO.
      origin: (origin, cb) => {
        if (env.isAllowedOrigin(origin)) return cb(null, true);
        return cb(new Error('Origin not allowed by CORS'));
      },
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
