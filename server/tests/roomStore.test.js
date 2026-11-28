import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  it('keeps the current host when a transfer target disconnects before confirmation', () => {
    const host = store.createRoom({ name: 'Host' });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });
    host.room.participants.get(guest.participantId).connected = false;

    expect(store.transferHost(host.room.code, host.participantId, guest.participantId).code).toBe('TARGET_NOT_CONNECTED');
    expect(host.room.participants.get(host.participantId).role).toBe('host');
  });

  it('allows up to 6 participants and rejects the 7th with the real limit in the message', () => {
    const sixStore = new RoomStore({ ttlMs: 60000, maxParticipants: 6, hostGraceMs: 5000 });
    const host = sixStore.createRoom({ name: 'Host' });
    for (let i = 1; i <= 5; i += 1) {
      const guest = sixStore.joinRoom({ roomCode: host.room.code, name: `Guest${i}` });
      expect(guest.error).toBeUndefined();
      expect(guest.role).toBe('guest');
    }
    expect(sixStore.serializeRoom(host.room).participants).toHaveLength(6);

    const seventh = sixStore.joinRoom({ roomCode: host.room.code, name: 'Seventh' });
    expect(seventh.code).toBe('ROOM_FULL');
    expect(seventh.error).toBe('Room is full (maximum 6 participants)');

    // The approval path (requestJoin) reports the same limit.
    const requested = sixStore.requestJoin({ roomCode: host.room.code, name: 'Eighth', socketId: 'sock-8' });
    expect(requested.code).toBe('ROOM_FULL');
    expect(requested.error).toBe('Room is full (maximum 6 participants)');
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

  it('allows guest queue additions by default and honors the host disabling them', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    expect(store.addToQueue(host.room.code, guest.participantId, { track: secondTrack }).addedItem?.track).toMatchObject(secondTrack);
    store.updateSettings(host.room.code, host.participantId, { allowGuestQueue: false });
    expect(store.addToQueue(host.room.code, guest.participantId, { track: secondTrack }).error).toMatch(/guest/i);
  });

  it('hands over a playing room without resetting its playback or keeping the retired host', () => {
    vi.useFakeTimers();
    try {
      const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
      const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });
      store.play(host.room.code, host.participantId, { positionMs: 15000 });
      store.markDisconnected(host.room.code, host.participantId);
      vi.advanceTimersByTime(5000);

      const state = store.serializeRoom(host.room);
      expect(state.participants.map(({ id, role }) => ({ id, role }))).toEqual([{ id: guest.participantId, role: 'host' }]);
      expect(state.playback.playbackState).toBe('playing');
      expect(store.reconnect({ roomCode: host.room.code, sessionToken: host.sessionToken }).error).toBeTruthy();
      expect(store.pause(host.room.code, guest.participantId, {}).room.playback.anchorPositionMs).toBe(20000);
    } finally {
      vi.useRealTimers();
    }
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

  it('starts stats.tracksPlayed at 0 (N-32) — nothing has played yet', () => {
    const res = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    expect(res.room.stats.tracksPlayed).toBe(0);
  });

  it('tolerates an unknown track duration instead of clamping to 210s (N-02)', () => {
    const unknownTrack = { ...sampleTrack, durationSec: null };
    const host = store.createRoom({ name: 'Host', initialTracks: [unknownTrack] });
    expect(host.room.playback.durationMs).toBe(0);
    // Seeking/playing past 3:30 must not be dragged back when duration is unknown.
    const seeked = store.seek(host.room.code, host.participantId, { positionMs: 300000 });
    expect(seeked.room.playback.anchorPositionMs).toBe(300000);
    const played = store.play(host.room.code, host.participantId, { positionMs: 240000 });
    expect(played.room.playback.anchorPositionMs).toBe(240000);
  });

  it('correctTrackDuration accepts a valid duration and rejects bad versions/ranges (N-02, B2)', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack, secondTrack] });
    const tv = host.room.playback.trackVersion;

    const ok = store.correctTrackDuration(host.room.code, host.participantId, {
      durationMs: 274000,
      trackVersion: tv,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.room.playback.durationMs).toBe(274000);
    expect(ok.room.queue[0].track.durationSec).toBe(274);

    const wrongVersion = store.correctTrackDuration(host.room.code, host.participantId, {
      durationMs: 200000,
      trackVersion: tv + 5,
    });
    expect(wrongVersion.code).toBe('VERSION_MISMATCH');
    expect(host.room.playback.durationMs).toBe(274000);

    const tooShort = store.correctTrackDuration(host.room.code, host.participantId, {
      durationMs: 5000,
      trackVersion: tv,
    });
    expect(tooShort.code).toBe('INVALID_DURATION');

    const tooLong = store.correctTrackDuration(host.room.code, host.participantId, {
      durationMs: 50000000,
      trackVersion: tv,
    });
    expect(tooLong.code).toBe('INVALID_DURATION');
    expect(host.room.playback.durationMs).toBe(274000);
  });

  it('advances exactly once per track end, and a stale endedTrackVersion does not advance (B2)', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack, secondTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });
    store.play(host.room.code, host.participantId, {});

    const tv1 = host.room.playback.trackVersion;
    const r1 = store.updatePlayerStatus(host.room.code, host.participantId, { endedTrackVersion: tv1 });
    expect(r1.autoAdvanced).toBe(true);
    expect(host.room.playback.trackId).toBe('trk-2');

    // Same (now stale) version reported again — must not advance a second time.
    const tv2 = host.room.playback.trackVersion;
    expect(tv2).not.toBe(tv1);
    const stale = store.updatePlayerStatus(host.room.code, guest.participantId, { endedTrackVersion: tv1 });
    expect(stale.autoAdvanced).toBe(false);
    expect(host.room.playback.trackId).toBe('trk-2');

    // The new version ending advances again (wraps to the first track).
    const r2 = store.updatePlayerStatus(host.room.code, guest.participantId, { endedTrackVersion: tv2 });
    expect(r2.autoAdvanced).toBe(true);
    expect(host.room.playback.trackId).toBe('trk-1');
  });

  it('rejoins idempotently by sessionToken instead of returning ROOM_FULL (M4, B2)', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    // Room is full, but the same guest token reuses the existing slot.
    const rejoined = store.joinRoom({
      roomCode: host.room.code,
      name: 'Guest',
      sessionToken: guest.sessionToken,
    });
    expect(rejoined.error).toBeUndefined();
    expect(rejoined.rejoined).toBe(true);
    expect(rejoined.participantId).toBe(guest.participantId);
    expect(rejoined.sessionToken).toBe(guest.sessionToken);
    expect(store.serializeRoom(rejoined.room).participants).toHaveLength(2);

    // A different guest still hits ROOM_FULL.
    const third = store.joinRoom({ roomCode: host.room.code, name: 'Third' });
    expect(third.code).toBe('ROOM_FULL');

    // A token for another room does not rejoin here.
    const other = store.createRoom({ name: 'Other' });
    const cross = store.joinRoom({
      roomCode: host.room.code,
      name: 'Guest',
      sessionToken: other.sessionToken,
    });
    expect(cross.code).toBe('ROOM_FULL');
  });

  it('exposes getPendingJoin/cancelJoinRequest so a dropped guest leaves no ghost (N-05, B2)', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    store.updateSettings(host.room.code, host.participantId, { requireApproval: true });

    const req = store.requestJoin({ roomCode: host.room.code, name: 'Guest', socketId: 'sock-1' });
    expect(store.getPendingJoin(host.room.code, req.request.id)).toMatchObject({ name: 'Guest' });
    expect(store.getPendingJoin(host.room.code, 'nope')).toBeNull();

    const cancelled = store.cancelJoinRequest(host.room.code, req.request.id);
    expect(cancelled.request.id).toBe(req.request.id);
    expect(store.getPendingJoin(host.room.code, req.request.id)).toBeNull();
    expect(store.serializeRoom(cancelled.room).pendingJoins).toHaveLength(0);

    // Approving the cancelled request now fails instead of creating a participant.
    const res = store.respondToJoin(host.room.code, host.participantId, {
      requestId: req.request.id,
      approve: true,
    });
    expect(res.code).toBe('NOT_FOUND');
    expect(store.serializeRoom(host.room).participants).toHaveLength(1);
  });

  it('dedupes pending joins by (name + source) as well as socketId (N-29)', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    store.updateSettings(host.room.code, host.participantId, { requireApproval: true });

    const req1 = store.requestJoin({ roomCode: host.room.code, name: 'Guest', source: 'youtube', socketId: 'sock-1' });
    // Same guest reconnects with a new socket — same pending request, no duplicate.
    const req2 = store.requestJoin({ roomCode: host.room.code, name: 'Guest', source: 'youtube', socketId: 'sock-2' });
    expect(req2.request.id).toBe(req1.request.id);
    expect(store.serializeRoom(host.room).pendingJoins).toHaveLength(1);

    // A different guest still gets their own request.
    const req3 = store.requestJoin({ roomCode: host.room.code, name: 'Other', source: 'youtube', socketId: 'sock-3' });
    expect(req3.request.id).not.toBe(req1.request.id);
    expect(store.serializeRoom(host.room).pendingJoins).toHaveLength(2);
  });

  it('removes a disconnected guest after the grace period and frees the slot (N-15)', async () => {
    const shortStore = new RoomStore({ ttlMs: 60000, maxParticipants: 2, hostGraceMs: 5000, guestGraceMs: 80 });
    const host = shortStore.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = shortStore.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    let removedRoom = null;
    shortStore.markDisconnected(host.room.code, guest.participantId, null, (room) => {
      removedRoom = room;
    });
    expect(shortStore.serializeRoom(host.room).participants).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 200));
    expect(removedRoom).not.toBeNull();
    expect(shortStore.serializeRoom(host.room).participants).toHaveLength(1);
    // Token freed: the old token no longer resolves, and a new guest can join.
    expect(shortStore.getParticipantBySessionToken(host.room.code, guest.sessionToken)).toBeNull();
    const replacement = shortStore.joinRoom({ roomCode: host.room.code, name: 'NewGuest' });
    expect(replacement.error).toBeUndefined();
    expect(replacement.role).toBe('guest');
  });

  it('does not remove a guest who reconnects before the grace period ends (N-15)', async () => {
    const shortStore = new RoomStore({ ttlMs: 60000, maxParticipants: 2, hostGraceMs: 5000, guestGraceMs: 80 });
    const host = shortStore.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = shortStore.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    shortStore.markDisconnected(host.room.code, guest.participantId);
    const rec = shortStore.reconnect({ roomCode: host.room.code, sessionToken: guest.sessionToken });
    expect(rec.error).toBeUndefined();

    await new Promise((r) => setTimeout(r, 200));
    expect(shortStore.serializeRoom(host.room).participants).toHaveLength(2);
  });

  it('never removes the host via the guest grace timer (N-15)', async () => {
    const shortStore = new RoomStore({ ttlMs: 60000, maxParticipants: 2, hostGraceMs: 5000, guestGraceMs: 80 });
    const host = shortStore.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    shortStore.markDisconnected(host.room.code, host.participantId);
    await new Promise((r) => setTimeout(r, 200));
    expect(shortStore.serializeRoom(host.room).participants).toHaveLength(1);
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
