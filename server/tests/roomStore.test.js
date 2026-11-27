import { describe, it, expect, beforeEach } from 'vitest';
import { RoomStore, generateSecureRoomCode } from '../src/stores/roomStore.js';

const sampleTrack = {
  id: 'trk-1',
  title: 'Midnight City',
  artist: 'M83',
  album: "Hurry Up, We're Dreaming",
  durationSec: 240,
  youtubeId: 'dX3k_QDnzHE',
};

const secondTrack = {
  id: 'trk-2',
  title: 'Resonance',
  artist: 'HOME',
  album: 'Odyssey',
  durationSec: 212,
  youtubeId: '8GW6sLrK40k',
};

describe('RoomStore unit tests', () => {
  let store;

  beforeEach(() => {
    store = new RoomStore({ ttlMs: 60000, maxParticipants: 2, hostGraceMs: 5000 });
  });

  it('generates 6-character unambiguous room codes', () => {
    const code = generateSecureRoomCode();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
  });

  it('creates a room with host role and unique session token', () => {
    const res = store.createRoom({ name: 'Sumit', source: 'youtube', initialTracks: [sampleTrack] });
    expect(res.room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(res.role).toBe('host');
    expect(res.sessionToken.length).toBeGreaterThanOrEqual(32);
    expect(res.room.queue).toHaveLength(1);
    expect(res.room.playback.durationMs).toBe(240000);
  });

  it('allows a guest to join and rejects a third participant', () => {
    const host = store.createRoom({ name: 'Host' });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });
    expect(guest.role).toBe('guest');
    expect(guest.error).toBeUndefined();

    const third = store.joinRoom({ roomCode: host.room.code, name: 'Third' });
    expect(third.code).toBe('ROOM_FULL');
  });

  it('enforces host authority on playback and queue mutations', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack, secondTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    const guestPlay = store.play(host.room.code, guest.participantId, {});
    expect(guestPlay.code).toBe('UNAUTHORIZED');

    const guestSeek = store.seek(host.room.code, guest.participantId, { positionMs: 10000 });
    expect(guestSeek.code).toBe('UNAUTHORIZED');

    const hostPlay = store.play(host.room.code, host.participantId, { positionMs: 15000 });
    expect(hostPlay.error).toBeUndefined();
    expect(hostPlay.room.playback.playbackState).toBe('playing');
    expect(hostPlay.room.playback.anchorPositionMs).toBe(15000);
  });

  it('handles duplicate commandId idempotently and skips stale roomVersion', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const v1 = host.room.roomVersion;

    const first = store.play(host.room.code, host.participantId, {
      positionMs: 5000,
      commandId: 'cmd-1',
      expectedRoomVersion: v1,
    });
    expect(first.skipped).toBeUndefined();
    const v2 = first.room.roomVersion;
    expect(v2).toBe(v1 + 1);

    const dup = store.play(host.room.code, host.participantId, {
      positionMs: 9000,
      commandId: 'cmd-1',
    });
    expect(dup.skipped).toBe('duplicate_command');
    expect(dup.room.playback.anchorPositionMs).toBe(5000);

    const stale = store.pause(host.room.code, host.participantId, {
      commandId: 'cmd-2',
      expectedRoomVersion: v1,
    });
    expect(stale.skipped).toBe('stale_version');
  });

  it('supports single-advance protection when both devices report track end', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack, secondTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });
    store.play(host.room.code, host.participantId, {});

    const tv = host.room.playback.trackVersion;
    const r1 = store.updatePlayerStatus(host.room.code, host.participantId, { endedTrackVersion: tv });
    const r2 = store.updatePlayerStatus(host.room.code, guest.participantId, { endedTrackVersion: tv });

    expect(r1.autoAdvanced).toBe(true);
    expect(r2.autoAdvanced).toBe(false);
    expect(host.room.playback.trackId).toBe('trk-2');
  });

  it('cleans up expired rooms', () => {
    const shortStore = new RoomStore({ ttlMs: 10 });
    const host = shortStore.createRoom({ name: 'Host' });
    host.room.expiresAtMs = Date.now() - 5;
    const removed = shortStore.cleanupExpired();
    expect(removed).toBe(1);
    expect(shortStore.getRoom(host.room.code)).toBeNull();
  });

  it('allows guest to control playback, queue, and settings when allowGuestControl is enabled', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    // Blocked by default
    expect(store.play(host.room.code, guest.participantId).code).toBe('UNAUTHORIZED');
    expect(store.updateSettings(host.room.code, guest.participantId, { theme: 'aurora' }).code).toBe('UNAUTHORIZED');

    // Host enables allowGuestControl
    const settingsRes = store.updateSettings(host.room.code, host.participantId, {
      allowGuestControl: true,
    });
    expect(settingsRes.room.settings.allowGuestControl).toBe(true);

    // Guest can now control playback, queue, and settings
    const playRes = store.play(host.room.code, guest.participantId, { positionMs: 5000 });
    expect(playRes.error).toBeUndefined();
    expect(playRes.room.playback.playbackState).toBe('playing');

    const addRes = store.addToQueue(host.room.code, guest.participantId, { track: secondTrack });
    expect(addRes.error).toBeUndefined();
    expect(addRes.room.queue).toHaveLength(2);

    const guestSettings = store.updateSettings(host.room.code, guest.participantId, { theme: 'aurora' });
    expect(guestSettings.error).toBeUndefined();
    expect(guestSettings.room.settings.theme).toBe('aurora');
  });

  it('queues join requests when requireApproval is enabled and lets host accept or decline', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    store.updateSettings(host.room.code, host.participantId, { requireApproval: true });

    const req1 = store.requestJoin({ roomCode: host.room.code, name: 'Guest1', socketId: 'sock-1' });
    expect(req1.request.name).toBe('Guest1');
    expect(store.serializeRoom(req1.room).pendingJoins).toHaveLength(1);

    const declined = store.respondToJoin(host.room.code, host.participantId, {
      requestId: req1.request.id,
      approve: false,
    });
    expect(declined.approved).toBe(false);
    expect(store.serializeRoom(declined.room).participants).toHaveLength(1);

    const req2 = store.requestJoin({ roomCode: host.room.code, name: 'Guest2', socketId: 'sock-2' });
    const approved = store.respondToJoin(host.room.code, host.participantId, {
      requestId: req2.request.id,
      approve: true,
    });
    expect(approved.approved).toBe(true);
    expect(store.serializeRoom(approved.room).participants).toHaveLength(2);
  });
});
