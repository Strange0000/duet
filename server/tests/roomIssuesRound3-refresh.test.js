// Regression tests for Failure 2 (PR #5 follow-up, live test 2026-11-28):
// after a guest refreshes, the song/position/theme restore at once, but the
// guest's chat failed with a persistent "Participant not found" error and
// the host showed the guest "Disconnected" for 30–60s.
//
// The server-side store/handler logic was verified sound for these
// sequences (the R2(a) stale-disconnect guard + grace-timer cancellation
// work): the actual gaps were client-side (commands sent before the socket
// was re-adopted, with no retry) and the missing positive presence signal
// (the server only ever emitted connection:status connected:false). These
// tests pin the server side: a refreshed guest stays adopted, survives
// past the grace period, can chat, and the host is told the guest is back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioc } from 'socket.io-client';
import { createApp } from '../src/index.js';
import { RoomStore } from '../src/stores/roomStore.js';

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Refreshed guest session (F2)', () => {
  let server;
  let port;
  let url;
  let cleanupInterval;
  let store;

  beforeAll(async () => {
    store = new RoomStore({ ttlMs: 60000, maxParticipants: 2, hostGraceMs: 500, guestGraceMs: 400 });
    const created = createApp({ store });
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

  async function setupRoom() {
    const host = ioc(url, { transports: ['websocket'] });
    const guest = ioc(url, { transports: ['websocket'] });
    await Promise.all([
      new Promise((r) => host.on('connect', r)),
      new Promise((r) => guest.on('connect', r)),
    ]);
    const created = await emitAck(host, 'room:create', { name: 'Host', source: 'local' });
    expect(created.ok).toBe(true);
    const joined = await emitAck(guest, 'room:join', { roomCode: created.roomCode, name: 'Guest' });
    expect(joined.ok).toBe(true);
    return {
      host,
      guest,
      roomCode: created.roomCode,
      guestSession: joined.sessionToken,
      guestId: joined.participantId,
    };
  }

  async function refreshGuest(roomCode, guestSession) {
    const refreshed = ioc(url, { transports: ['websocket'] });
    await new Promise((r) => refreshed.on('connect', r));
    // The refreshed page does both: App.jsx sends room:join with the stored
    // sessionToken, and the socket connect handler sends room:reconnect.
    const rejoined = await emitAck(refreshed, 'room:join', {
      roomCode,
      name: 'Guest',
      sessionToken: guestSession,
    });
    expect(rejoined.ok).toBe(true);
    const rec = await emitAck(refreshed, 'room:reconnect', { roomCode, sessionToken: guestSession });
    expect(rec.ok).toBe(true);
    return refreshed;
  }

  async function participantsOf(host) {
    const state = await emitAck(host, 'sync:request', {});
    return state.state.participants;
  }

  it('refresh (disconnect + rejoin + reconnect) then chat works, and still works after the grace period', async () => {
    const { host, guest, roomCode, guestSession } = await setupRoom();
    try {
      guest.disconnect();
      await sleep(50);
      const refreshed = await refreshGuest(roomCode, guestSession);
      try {
        const chat1 = await emitAck(refreshed, 'chat:send', { text: 'hello after refresh' });
        expect(chat1.ok).toBe(true);
        // Past the guest grace period: the participant must still be there
        // (the refresh must not leave a stale grace timer that deletes them).
        await sleep(900);
        const participants = await participantsOf(host);
        expect(participants).toHaveLength(2);
        expect(participants.find((p) => p.id === participants[1]?.id)).toBeTruthy();
        const chat2 = await emitAck(refreshed, 'chat:send', { text: 'hello after grace' });
        expect(chat2.ok).toBe(true);
      } finally {
        refreshed.disconnect();
      }
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('a late stale disconnect (old socket id) after re-attach is ignored; chat works after grace', async () => {
    const { host, guest, roomCode, guestSession, guestId } = await setupRoom();
    try {
      const oldSocketId = guest.id;
      guest.disconnect();
      await sleep(50);
      const refreshed = await refreshGuest(roomCode, guestSession);
      try {
        // The old socket's disconnect is only noticed by the server NOW
        // (late heartbeat detection) — simulate it directly against the
        // store. The R2(a) guard must ignore it: the participant has a
        // different live socket.
        const ignored = store.markDisconnected(roomCode, guestId, null, null, oldSocketId);
        expect(ignored).toBeNull();
        const chat1 = await emitAck(refreshed, 'chat:send', { text: 'hello after late disconnect' });
        expect(chat1.ok).toBe(true);
        await sleep(900);
        expect(await participantsOf(host)).toHaveLength(2);
        const chat2 = await emitAck(refreshed, 'chat:send', { text: 'hello after grace' });
        expect(chat2.ok).toBe(true);
      } finally {
        refreshed.disconnect();
      }
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('disconnect, reconnect, then the NEW socket drops and reconnects again; chat works after grace', async () => {
    const { host, guest, roomCode, guestSession } = await setupRoom();
    try {
      guest.disconnect();
      await sleep(50);
      const refreshed = await refreshGuest(roomCode, guestSession);
      try {
        // The refreshed socket drops again (network blip) and reconnects.
        refreshed.disconnect();
        await sleep(50);
        const refreshed2 = ioc(url, { transports: ['websocket'] });
        await new Promise((r) => refreshed2.on('connect', r));
        try {
          const rec = await emitAck(refreshed2, 'room:reconnect', { roomCode, sessionToken: guestSession });
          expect(rec.ok).toBe(true);
          const chat1 = await emitAck(refreshed2, 'chat:send', { text: 'hello after second reconnect' });
          expect(chat1.ok).toBe(true);
          await sleep(900);
          expect(await participantsOf(host)).toHaveLength(2);
          const chat2 = await emitAck(refreshed2, 'chat:send', { text: 'hello after grace' });
          expect(chat2.ok).toBe(true);
        } finally {
          refreshed2.disconnect();
        }
      } finally {
        refreshed.disconnect();
      }
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('the host receives connection:status connected:true when the refreshed guest re-adopts', async () => {
    const { host, guest, roomCode, guestSession, guestId } = await setupRoom();
    const statuses = [];
    host.on('connection:status', (ev) => statuses.push(ev));
    try {
      guest.disconnect();
      await sleep(50);
      const refreshed = await refreshGuest(roomCode, guestSession);
      try {
        await sleep(50);
        // The host must be told the guest is back (positive signal) — the
        // server used to only emit connected:false, so the host kept
        // showing "Disconnected" until the guest produced traffic.
        expect(
          statuses.some((s) => s.participantId === guestId && s.connected === true)
        ).toBe(true);
      } finally {
        refreshed.disconnect();
      }
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });
});
