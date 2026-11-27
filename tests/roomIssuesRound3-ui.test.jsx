// @vitest-environment jsdom
// Regression tests — Round 3 room UI issues (R7 + extras).
// (b) Distinct auto-names within a room: the server must never give two
// participants in the same room the same name (live test: both participants
// were auto-named "Diana", so toasts/names were ambiguous).
// (d) The per-track add button in the search panel must read "Add to Queue".
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RoomStore } from '../server/src/stores/roomStore.js';
import { RoomContext } from '../src/context/RoomContext.jsx';
import RoomView from '../src/components/RoomView.jsx';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';

describe('R7(b) distinct participant names within a room', () => {
  it('a guest joining with the host name gets a suffixed name', () => {
    const store = new RoomStore();
    const created = store.createRoom({ name: 'Diana' });
    const joined = store.joinRoom({ roomCode: created.room.code, name: 'Diana' });
    expect(joined.error).toBeUndefined();
    const names = Array.from(created.room.participants.values()).map((p) => p.name);
    expect(names).toEqual(['Diana', 'Diana 2']);
  });

  it('name collision is case-insensitive', () => {
    const store = new RoomStore();
    const created = store.createRoom({ name: 'Diana' });
    const joined = store.joinRoom({ roomCode: created.room.code, name: 'diana' });
    const names = Array.from(created.room.participants.values()).map((p) => p.name);
    expect(joined.error).toBeUndefined();
    expect(names).toEqual(['Diana', 'diana 2']);
  });

  it('a rejoin with a session token keeps its existing name (no suffix)', () => {
    const store = new RoomStore();
    const created = store.createRoom({ name: 'Diana' });
    const joined = store.joinRoom({ roomCode: created.room.code, name: 'Diana' });
    const rejoined = store.joinRoom({
      roomCode: created.room.code,
      name: 'Diana',
      sessionToken: joined.sessionToken,
    });
    expect(rejoined.rejoined).toBe(true);
    expect(created.room.participants.size).toBe(2);
    const names = Array.from(created.room.participants.values()).map((p) => p.name);
    expect(names).toEqual(['Diana', 'Diana 2']);
  });

  it('pending join requests get distinct names too', () => {
    const store = new RoomStore();
    const created = store.createRoom({ name: 'Diana' });
    const first = store.requestJoin({ roomCode: created.room.code, name: 'Diana', source: 'youtube', socketId: 's1' });
    const second = store.requestJoin({ roomCode: created.room.code, name: 'Diana', source: 'spotify', socketId: 's2' });
    expect(first.request.name).toBe('Diana 2');
    expect(second.request.name).toBe('Diana 3');
  });

  it('renaming to a taken name gets a suffix; renaming to your own name is unchanged', () => {
    const store = new RoomStore();
    const created = store.createRoom({ name: 'Diana' });
    const joined = store.joinRoom({ roomCode: created.room.code, name: 'Guest' });
    const renamed = store.updateParticipant(created.room.code, joined.participantId, { name: 'Diana' });
    expect(renamed.participant.name).toBe('Diana 2');
    const ownName = store.updateParticipant(created.room.code, joined.participantId, { name: 'Diana 2' });
    expect(ownName.participant.name).toBe('Diana 2');
  });
});

// --- RoomView search-panel button label (d) ---
// Same minimal-but-complete context shape as tests/roomView.test.jsx.
function makeRoomState() {
  return {
    roomCode: 'TEST01',
    lifecycleState: 'active',
    settings: { allowGuestControl: true, requireApproval: false, theme: 'midnight' },
    participants: [
      {
        id: 'host-1',
        name: 'Host',
        role: 'host',
        source: 'youtube',
        connected: true,
        ready: true,
        buffering: false,
        reportedPositionMs: 0,
      },
    ],
    queue: INITIAL_TRACKS.map((t, i) => ({
      queueItemId: `q-${i}`,
      track: t,
      addedByName: 'Host',
    })),
    currentQueueItemId: 'q-0',
    playback: {
      playbackState: 'paused',
      positionMs: 0,
      durationMs: 243000,
      trackVersion: 1,
    },
    chat: [],
    pendingJoins: [],
    stats: { tracksPlayed: 0, durationMs: 0 },
  };
}

function makeCtx(overrides = {}) {
  const rs = makeRoomState();
  return {
    roomState: rs,
    session: { roomCode: 'TEST01', participantId: 'host-1', role: 'host', sessionToken: 'tok' },
    myParticipant: rs.participants[0],
    partnerParticipant: null,
    currentTrack: INITIAL_TRACKS[0],
    connectionStatus: 'connected',
    pendingApproval: false,
    roomError: null,
    playerError: null,
    audioUnlocked: false,
    syncMetrics: {
      rttMs: 100,
      clockOffsetMs: 0,
      driftMs: 50,
      reportedPositionMs: 0,
      expectedPositionMs: 0,
      correctionCount: 0,
      reconnectCount: 0,
      lastSyncedAtMs: null,
    },
    syncStatus: 'waiting',
    volume: 0.85,
    muted: false,
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    getCurrentPositionMs: vi.fn().mockResolvedValue(0),
    clearRoomError: vi.fn(),
    reactions: [],
    unreadChatCount: 0,
    setUnreadChatCount: vi.fn(),
    partnerTyping: false,
    playerContainerRef: { current: null },
    initPlayerForSource: vi.fn(),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    unlockAudio: vi.fn(),
    runClockSync: vi.fn(),
    sendCommand: vi.fn(),
    setPlayerError: vi.fn(),
    setRoomError: vi.fn(),
    ...overrides,
  };
}

describe('search panel add button (d)', () => {
  it('per-track add buttons read "Add to Queue"', () => {
    const ctx = makeCtx();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView isDemo={false} onLeave={() => {}} />
        </RoomContext.Provider>
      );
    });
    // Open the search ("Add") tab, then check the per-track buttons.
    const tabButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Add'
    );
    expect(tabButton).toBeDefined();
    act(() => {
      tabButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const addButtons = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent.trim() === 'Add to Queue'
    );
    expect(addButtons.length).toBeGreaterThan(0);
    // The only button still saying just "Add" is the search tab itself
    // (a tab label, not an add action — deliberately left unchanged).
    const bareAddButtons = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent.trim() === 'Add'
    );
    expect(bareAddButtons.length).toBe(1);
    act(() => root.unmount());
    container.remove();
  });
});
