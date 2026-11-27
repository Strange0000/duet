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
    expect(providers.body.spotify.available).toBe(true);
  });

  it('GET /api/youtube/resolve reports configured:false with no API key (N-01)', async () => {
    const res = await request(app).get('/api/youtube/resolve?title=Midnight%20City&artist=M83');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ item: null, configured: false });

    const missing = await request(app).get('/api/youtube/resolve');
    expect(missing.status).toBe(400);
  });

  it('player:duration corrects an unknown duration; wrong version/range rejected (N-02)', async () => {
    const hostSocket = ioc(url, { transports: ['websocket'] });
    await new Promise((r) => hostSocket.on('connect', r));
    try {
      const created = await emitAck(hostSocket, 'room:create', {
        name: 'Sumit',
        source: 'local',
        initialTracks: [
          { id: 'fix-1', title: 'Pulse Horizon', artist: 'Duet Fixture', durationSec: 120, localFixtureId: 'pulse-horizon' },
        ],
      });
      expect(created.ok).toBe(true);
      const tv = created.state.playback.trackVersion;

      const ok = await emitAck(hostSocket, 'player:duration', { durationMs: 274000, trackVersion: tv });
      expect(ok.ok).toBe(true);
      expect(ok.playback.durationMs).toBe(274000);
      expect(ok.state.queue[0].track.durationSec).toBe(274);

      const wrongVersion = await emitAck(hostSocket, 'player:duration', { durationMs: 200000, trackVersion: tv + 9 });
      expect(wrongVersion.ok).toBe(false);
      expect(wrongVersion.code).toBe('VERSION_MISMATCH');

      const tooShort = await emitAck(hostSocket, 'player:duration', { durationMs: 5000, trackVersion: tv });
      expect(tooShort.ok).toBe(false);

      // Host socket was attached at creation (N-04): a fresh join attempt by a
      // third socket still sees the room as full, i.e. the host occupies a slot.
      const thirdSocket = ioc(url, { transports: ['websocket'] });
      const fourthSocket = ioc(url, { transports: ['websocket'] });
      await Promise.all([
        new Promise((r) => thirdSocket.on('connect', r)),
        new Promise((r) => fourthSocket.on('connect', r)),
      ]);
      try {
        const guest = await emitAck(thirdSocket, 'room:join', { roomCode: created.roomCode, name: 'Guest' });
        expect(guest.ok).toBe(true);
        const third = await emitAck(fourthSocket, 'room:join', {
          roomCode: created.roomCode,
          name: 'Third',
        });
        expect(third.ok).toBe(false);
        expect(third.code).toBe('ROOM_FULL');
      } finally {
        thirdSocket.disconnect();
        fourthSocket.disconnect();
      }
    } finally {
      hostSocket.disconnect();
    }
  });

  it('room:join with a sessionToken rejoins the same guest slot after refresh (M4)', async () => {
    const hostSocket = ioc(url, { transports: ['websocket'] });
    const guestSocket = ioc(url, { transports: ['websocket'] });
    await Promise.all([
      new Promise((r) => hostSocket.on('connect', r)),
      new Promise((r) => guestSocket.on('connect', r)),
    ]);
    try {
      const created = await emitAck(hostSocket, 'room:create', { name: 'Host', source: 'local' });
      const joined = await emitAck(guestSocket, 'room:join', { roomCode: created.roomCode, name: 'Guest' });
      expect(joined.ok).toBe(true);

      // Guest "refreshes": new socket, same sessionToken — same participant,
      // no ROOM_FULL, even though the room already has 2 participants.
      guestSocket.disconnect();
      await new Promise((r) => setTimeout(r, 50));
      const refreshed = ioc(url, { transports: ['websocket'] });
      await new Promise((r) => refreshed.on('connect', r));
      try {
        const rejoined = await emitAck(refreshed, 'room:join', {
          roomCode: created.roomCode,
          name: 'Guest',
          sessionToken: joined.sessionToken,
        });
        expect(rejoined.ok).toBe(true);
        expect(rejoined.participantId).toBe(joined.participantId);
        expect(rejoined.sessionToken).toBe(joined.sessionToken);
        expect(rejoined.state.participants).toHaveLength(2);
      } finally {
        refreshed.disconnect();
      }
    } finally {
      hostSocket.disconnect();
      guestSocket.disconnect();
    }
  });

  it('approving a join after the guest disconnected creates no ghost participant (N-05)', async () => {
    const hostSocket = ioc(url, { transports: ['websocket'] });
    const guestSocket = ioc(url, { transports: ['websocket'] });
    await Promise.all([
      new Promise((r) => hostSocket.on('connect', r)),
      new Promise((r) => guestSocket.on('connect', r)),
    ]);
    try {
      const created = await emitAck(hostSocket, 'room:create', { name: 'Host', source: 'local' });
      const roomCode = created.roomCode;
      const settings = await emitAck(hostSocket, 'room:settings', { requireApproval: true });
      expect(settings.ok).toBe(true);

      const pending = await emitAck(guestSocket, 'room:join', { roomCode, name: 'Guest' });
      expect(pending.ok).toBe(true);
      expect(pending.pendingApproval).toBe(true);
      expect(pending.sessionToken).toBeUndefined();

      // Guest's socket drops before the host approves.
      guestSocket.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const decision = await emitAck(hostSocket, 'room:join-respond', {
        requestId: pending.requestId,
        approve: true,
      });
      expect(decision.ok).toBe(false);
      // No ghost: the room still has only the host, and a new guest can join.
      const state = await emitAck(hostSocket, 'sync:request', {});
      expect(state.state.participants).toHaveLength(1);

      const replacement = ioc(url, { transports: ['websocket'] });
      await new Promise((r) => replacement.on('connect', r));
      try {
        const joined = await emitAck(replacement, 'room:join', { roomCode, name: 'Replacement' });
        // Still requireApproval: a fresh pending request, not a ROOM_FULL.
        expect(joined.ok).toBe(true);
        expect(joined.pendingApproval).toBe(true);
      } finally {
        replacement.disconnect();
      }
    } finally {
      hostSocket.disconnect();
      guestSocket.disconnect();
    }
  });

  it('player:seek and chat:typing are rate-limited per participant (N-06, N-11)', async () => {
    const hostSocket = ioc(url, { transports: ['websocket'] });
    await new Promise((r) => hostSocket.on('connect', r));
    try {
      const created = await emitAck(hostSocket, 'room:create', {
        name: 'Host',
        source: 'local',
        initialTracks: [
          { id: 'fix-1', title: 'Pulse Horizon', artist: 'Duet Fixture', durationSec: 120, localFixtureId: 'pulse-horizon' },
        ],
      });
      expect(created.ok).toBe(true);

      let lastSeek = null;
      for (let i = 0; i < 11; i++) {
        lastSeek = await emitAck(hostSocket, 'player:seek', { positionMs: 1000 + i });
      }
      expect(lastSeek.ok).toBe(false);
      expect(lastSeek.code).toBe('RATE_LIMITED');

      let lastTyping = null;
      for (let i = 0; i < 11; i++) {
        lastTyping = await emitAck(hostSocket, 'chat:typing', {});
      }
      expect(lastTyping.ok).toBe(false);
      expect(lastTyping.code).toBe('RATE_LIMITED');
    } finally {
      hostSocket.disconnect();
    }
  });

  it('player:next, player:previous and queue:clear validate payloads but accept valid calls (N-13)', async () => {
    const hostSocket = ioc(url, { transports: ['websocket'] });
    await new Promise((r) => hostSocket.on('connect', r));
    try {
      const created = await emitAck(hostSocket, 'room:create', {
        name: 'Host',
        source: 'local',
        initialTracks: [
          { id: 'fix-1', title: 'Pulse Horizon', artist: 'Duet Fixture', durationSec: 120, localFixtureId: 'pulse-horizon' },
          { id: 'fix-2', title: 'Velvet Drift', artist: 'Duet Fixture', durationSec: 140, localFixtureId: 'velvet-drift' },
        ],
      });
      expect(created.ok).toBe(true);

      const next = await emitAck(hostSocket, 'player:next', {});
      expect(next.ok).toBe(true);
      expect(next.state.playback.trackId).toBe('fix-2');

      const prev = await emitAck(hostSocket, 'player:previous', { commandId: 'cmd-prev-1' });
      expect(prev.ok).toBe(true);
      expect(prev.state.playback.trackId).toBe('fix-1');

      const bad = await emitAck(hostSocket, 'player:next', { expectedRoomVersion: 'not-a-number' });
      expect(bad.ok).toBe(false);

      const cleared = await emitAck(hostSocket, 'queue:clear', {});
      expect(cleared.ok).toBe(true);
      expect(cleared.state.queue).toHaveLength(0);
    } finally {
      hostSocket.disconnect();
    }
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
