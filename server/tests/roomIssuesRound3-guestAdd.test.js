import { describe, it, expect, beforeEach } from 'vitest';
import { RoomStore } from '../src/stores/roomStore.js';

// R2 (round 3): guest queue-add failures from the 2026-11-28 live room test.
// - (a) a guest add failed with 'Participant not found' although the guest
//   was a real participant: a stale disconnect (old socket noticed dead
//   after the participant re-attached on a new socket) armed the guest
//   grace timer, which then deleted the live participant.
// - (b) when guest adds are genuinely disabled the error must carry the
//   distinct GUEST_QUEUE_DISABLED code and the honest message — never
//   'Participant not found'.
// - (c) new rooms default allowGuestQueue to true.

const sampleTrack = {
  id: 'trk-1',
  title: 'Midnight City',
  artist: 'M83',
  album: "Hurry Up, We're Dreaming",
  durationSec: 240,
  youtubeId: 'dX3k_QDnzHE',
};

const guestTrack = {
  id: 'trk-guest',
  title: 'Shape of You',
  artist: 'Ed Sheeran',
  album: '÷',
  durationSec: 263,
  youtubeId: 'JGwWNGJdvx8',
};

describe('R2 guest queue-add (round 3)', () => {
  let store;

  beforeEach(() => {
    store = new RoomStore({ ttlMs: 60000, maxParticipants: 2, hostGraceMs: 5000 });
  });

  const makeRoomWithGuest = () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = store.joinRoom({ roomCode: host.room.code, name: 'Guest' });
    return { host, guest };
  };

  it('(c) new rooms default allowGuestQueue to true', () => {
    const host = store.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    expect(host.room.settings.allowGuestQueue).toBe(true);
    expect(store.serializeRoom(host.room).settings.allowGuestQueue).toBe(true);
  });

  it('(c) a joined guest can add to the queue by default, with no host action', () => {
    const { host, guest } = makeRoomWithGuest();
    const res = store.addToQueue(host.room.code, guest.participantId, { track: guestTrack });
    expect(res.error).toBeUndefined();
    expect(res.addedItem).toBeDefined();
    expect(res.addedItem.addedBy).toBe(guest.participantId);
    expect(store.serializeRoom(host.room).queue).toHaveLength(2);
  });

  it('(b) disabled guest adds return GUEST_QUEUE_DISABLED with the honest message', () => {
    const { host, guest } = makeRoomWithGuest();
    const settingsRes = store.updateSettings(host.room.code, host.participantId, {
      allowGuestQueue: false,
    });
    expect(settingsRes.room.settings.allowGuestQueue).toBe(false);

    const res = store.addToQueue(host.room.code, guest.participantId, { track: guestTrack });
    expect(res.error).toBe('Guest queue additions are disabled by the host');
    expect(res.code).toBe('GUEST_QUEUE_DISABLED');
    expect(res.code).not.toBe('UNAUTHORIZED');
    expect(res.error).not.toMatch(/Participant not found/);
    expect(store.serializeRoom(host.room).queue).toHaveLength(1);
  });

  it('(b) the host can still add while guest adds are disabled', () => {
    const { host } = makeRoomWithGuest();
    store.updateSettings(host.room.code, host.participantId, { allowGuestQueue: false });
    const res = store.addToQueue(host.room.code, host.participantId, { track: guestTrack });
    expect(res.error).toBeUndefined();
    expect(store.serializeRoom(host.room).queue).toHaveLength(2);
  });

  it('(a) a stale disconnect does not delete a guest who re-attached on a new socket', async () => {
    const shortStore = new RoomStore({
      ttlMs: 60000,
      maxParticipants: 2,
      hostGraceMs: 5000,
      guestGraceMs: 80,
    });
    const host = shortStore.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = shortStore.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    // Guest joins on sock-1, drops, and re-attaches on sock-2.
    shortStore.attachSocket(host.room.code, guest.participantId, 'sock-1');
    shortStore.attachSocket(host.room.code, guest.participantId, 'sock-2');

    // The server only notices sock-1 is dead later: its disconnect must NOT
    // mark the live participant disconnected or arm the grace timer.
    const ignored = shortStore.markDisconnected(
      host.room.code,
      guest.participantId,
      null,
      null,
      'sock-1'
    );
    expect(ignored).toBeNull();

    const participant = shortStore
      .serializeRoom(host.room)
      .participants.find((p) => p.id === guest.participantId);
    expect(participant.connected).toBe(true);

    // Past the grace period the guest is still in the room and can add.
    await new Promise((r) => setTimeout(r, 200));
    expect(shortStore.serializeRoom(host.room).participants).toHaveLength(2);
    expect(
      shortStore.getParticipantBySessionToken(host.room.code, guest.sessionToken)
    ).not.toBeNull();
    const addRes = shortStore.addToQueue(host.room.code, guest.participantId, {
      track: guestTrack,
    });
    expect(addRes.error).toBeUndefined();
  });

  it('(a) a genuine disconnect on the current socket still removes the guest after grace (N-15)', async () => {
    const shortStore = new RoomStore({
      ttlMs: 60000,
      maxParticipants: 2,
      hostGraceMs: 5000,
      guestGraceMs: 80,
    });
    const host = shortStore.createRoom({ name: 'Host', initialTracks: [sampleTrack] });
    const guest = shortStore.joinRoom({ roomCode: host.room.code, name: 'Guest' });

    shortStore.attachSocket(host.room.code, guest.participantId, 'sock-1');
    let removedRoom = null;
    shortStore.markDisconnected(host.room.code, guest.participantId, null, (room) => {
      removedRoom = room;
    }, 'sock-1');

    await new Promise((r) => setTimeout(r, 200));
    expect(removedRoom).not.toBeNull();
    expect(shortStore.serializeRoom(host.room).participants).toHaveLength(1);
    expect(
      shortStore.getParticipantBySessionToken(host.room.code, guest.sessionToken)
    ).toBeNull();
  });
});
