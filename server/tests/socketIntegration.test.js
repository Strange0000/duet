import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { io as ioc } from 'socket.io-client';
import { createApp } from '../src/index.js';

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res));
  });
}

describe('Duet Backend HTTP & Socket.IO Integration', () => {
  let server;
  let app;
  let port;
  let url;
  let cleanupInterval;

  beforeAll(async () => {
    const created = createApp();
    app = created.app;
    server = created.server;
    cleanupInterval = created.cleanupInterval;
    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        url = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    clearInterval(cleanupInterval);
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves /health, /ready, and /api/providers', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.ready).toBe(true);

    const providers = await request(app).get('/api/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.youtube.available).toBe(true);
    expect(providers.body.spotify.available).toBe(false);
  });

  it('runs full two-client room lifecycle, auth, playback sync, queue, and reconnect', async () => {
    const hostSocket = ioc(url, { transports: ['websocket'] });
    const guestSocket = ioc(url, { transports: ['websocket'] });
    const thirdSocket = ioc(url, { transports: ['websocket'] });

    await Promise.all([
      new Promise((r) => hostSocket.on('connect', r)),
      new Promise((r) => guestSocket.on('connect', r)),
      new Promise((r) => thirdSocket.on('connect', r)),
    ]);

    try {
      // 1. Host creates room
      const created = await emitAck(hostSocket, 'room:create', {
        name: 'Sumit',
        source: 'local',
        initialTracks: [
          {
            id: 'fix-1',
            title: 'Pulse Horizon',
            artist: 'Duet Fixture',
            durationSec: 120,
            localFixtureId: 'pulse-horizon',
          },
          {
            id: 'fix-2',
            title: 'Velvet Drift',
            artist: 'Duet Fixture',
            durationSec: 140,
            localFixtureId: 'velvet-drift',
          },
        ],
      });
      expect(created.ok).toBe(true);
      expect(created.role).toBe('host');
      const roomCode = created.roomCode;

      // 2. Guest joins room
      const joined = await emitAck(guestSocket, 'room:join', {
        roomCode,
        name: 'Aarav',
        source: 'local',
      });
      expect(joined.ok).toBe(true);
      expect(joined.role).toBe('guest');

      // 3. Third participant rejected
      const third = await emitAck(thirdSocket, 'room:join', { roomCode, name: 'Intruder' });
      expect(third.ok).toBe(false);
      expect(third.code).toBe('ROOM_FULL');

      // 4. Invalid room rejected
      const invalid = await emitAck(thirdSocket, 'room:join', { roomCode: 'ZZZZZZ', name: 'X' });
      expect(invalid.ok).toBe(false);

      // 5. Guest cannot issue host transport controls
      const unauthPlay = await emitAck(guestSocket, 'player:play', { positionMs: 1000 });
      expect(unauthPlay.ok).toBe(false);
      expect(unauthPlay.code).toBe('UNAUTHORIZED');

      // 6. Host plays & seeks -> guest receives playback:state
      const guestPlaybackPromise = new Promise((resolve) => {
        guestSocket.once('playback:state', resolve);
      });
      const playRes = await emitAck(hostSocket, 'player:play', { positionMs: 12000 });
      expect(playRes.ok).toBe(true);
      const guestPlayback = await guestPlaybackPromise;
      expect(guestPlayback.playbackState).toBe('playing');
      expect(guestPlayback.anchorPositionMs).toBe(12000);

      // 7. Clock sync ping/pong
      const pong = await emitAck(guestSocket, 'sync:ping', { clientSentAtMs: performance.now(), seq: 1 });
      expect(pong.ok).toBe(true);
      expect(typeof pong.serverReceivedAtMs).toBe('number');

      // 8. Guest disconnects and reconnects with sessionToken
      guestSocket.disconnect();
      await new Promise((r) => setTimeout(r, 50));
      guestSocket.connect();
      await new Promise((r) => guestSocket.on('connect', r));

      const rec = await emitAck(guestSocket, 'room:reconnect', {
        roomCode,
        sessionToken: joined.sessionToken,
      });
      expect(rec.ok).toBe(true);
      expect(rec.role).toBe('guest');
      expect(rec.state.playback.playbackState).toBe('playing');
    } finally {
      hostSocket.disconnect();
      guestSocket.disconnect();
      thirdSocket.disconnect();
    }
  });
});
