// @vitest-environment jsdom
// Round 3 regressions (live room test 2026-11-28, room UA4DVX):
//  R3 — presence must reflect the partner's ACTUAL liveness: the server's
//       per-participant `connected` flag flips to false on any transient
//       socket drop, so the indicator showed "Disconnected" while the
//       partner's Next/Pause/chat kept arriving. Derived presence (flag +
//       recent partner traffic + grace window) must stay connected while
//       their traffic flows, and only flip to disconnected once the
//       traffic has been silent past the grace window.
//  R6 — on (re)join the client must adopt the room's current playback
//       position AND theme from the room state it receives, BEFORE any
//       audio-unlock tap. The unlock tap must only unlock audio.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const handlers = {};
const fakeSocket = {
  connected: false,
  connect: vi.fn(() => {
    fakeSocket.connected = true;
  }),
  on: vi.fn((event, fn) => {
    (handlers[event] ||= []).push(fn);
  }),
  off: vi.fn((event, fn) => {
    handlers[event] = (handlers[event] || []).filter((f) => f !== fn);
  }),
  emit: vi.fn(),
};

vi.mock('../src/services/socketClient', () => ({
  getSocket: () => fakeSocket,
  emitAck: vi.fn(),
  generateCommandId: () => 'cmd-test',
}));

import { RoomContext, RoomProvider, useRoom } from '../src/context/RoomContext.jsx';
import { emitAck } from '../src/services/socketClient';
import RoomView from '../src/components/RoomView.jsx';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fire(event, ...args) {
  const fns = [...(handlers[event] || [])];
  fns.forEach((fn) => fn(...args));
}

function makeRoomState(overrides = {}) {
  const base = {
    roomCode: 'UA4DVX',
    lifecycleState: 'active',
    roomVersion: 7,
    settings: {
      allowGuestControl: false,
      allowGuestQueue: false,
      requireApproval: false,
      theme: 'sunset',
    },
    participants: [
      {
        id: 'host-1',
        name: 'Host',
        role: 'host',
        source: 'youtube',
        connected: true,
        ready: true,
        buffering: false,
        reportedPositionMs: 10000,
      },
      {
        id: 'guest-1',
        name: 'Guest',
        role: 'guest',
        source: 'youtube',
        connected: true,
        ready: false,
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
    // Host paused at 00:55 — the exact rejoin case from the live test.
    playback: {
      playbackState: 'paused',
      anchorPositionMs: 55000,
      durationMs: 243000,
      trackVersion: 1,
    },
    chat: [],
    pendingJoins: [],
    stats: { tracksPlayed: 0, durationMs: 0 },
  };
  return { ...base, ...overrides };
}

function joinResult(state) {
  return {
    ok: true,
    roomCode: 'UA4DVX',
    participantId: 'guest-1',
    sessionToken: 'tok-guest',
    role: 'guest',
    state,
  };
}

function Probe() {
  const ctx = useRoom();
  return (
    <div>
      <span data-testid="partner-connected">{String(ctx.partnerConnected)}</span>
      <span data-testid="reported">{ctx.syncMetrics.reportedPositionMs}</span>
      <span data-testid="expected">{ctx.syncMetrics.expectedPositionMs}</span>
      <span data-testid="theme">{ctx.roomState?.settings?.theme || ''}</span>
      <span data-testid="audio">{String(ctx.audioUnlocked)}</span>
      <button
        data-testid="join"
        onClick={() =>
          ctx.joinRoom({
            roomCode: 'UA4DVX',
            name: 'Guest',
            source: 'youtube',
            sessionToken: 'tok-guest',
          })
        }
      >
        join
      </button>
    </div>
  );
}

const mounted = [];

function mountProbe() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(
      <RoomProvider>
        <Probe />
      </RoomProvider>
    );
  });
  const text = (testid) => container.querySelector(`[data-testid="${testid}"]`)?.textContent;
  return { container, root, text };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(handlers)) delete handlers[key];
  fakeSocket.connected = false;
  emitAck.mockImplementation((event) => {
    if (event === 'sync:ping') {
      const now = Date.now();
      return Promise.resolve({ ok: true, serverReceivedAtMs: now, serverSentAtMs: now });
    }
    return Promise.resolve({ ok: true });
  });
});

afterEach(() => {
  vi.useRealTimers();
  while (mounted.length) {
    const { container, root } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
});

describe('R6: rejoin adopts position + theme before the audio-unlock tap', () => {
  it('joinRoom adopts the paused 00:55 position and Sunset theme while audio is still locked', async () => {
    const state = makeRoomState();
    emitAck.mockImplementation((event) => {
      if (event === 'room:join') return Promise.resolve(joinResult(state));
      if (event === 'sync:request') return Promise.resolve({ ok: true, state });
      if (event === 'sync:ping') {
        const now = Date.now();
        return Promise.resolve({ ok: true, serverReceivedAtMs: now, serverSentAtMs: now });
      }
      return Promise.resolve({ ok: true });
    });
    const { container, text } = mountProbe();
    await act(async () => {
      container.querySelector('[data-testid="join"]').click();
      await sleep(700);
    });
    expect(text('audio')).toBe('false');
    expect(text('theme')).toBe('sunset');
    expect(text('reported')).toBe('55000');
    expect(text('expected')).toBe('55000');
  });

  it('a room:joined (reconnect) event adopts position + theme without an unlock tap', async () => {
    const state = makeRoomState();
    const { text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(state));
    });
    await act(async () => {
      await sleep(500);
    });
    expect(text('audio')).toBe('false');
    expect(text('theme')).toBe('sunset');
    expect(text('reported')).toBe('55000');
  });
});

describe('R3: presence reflects live partner traffic, not the stale server flag', () => {
  it('partner stays connected while their position reports and chat keep arriving despite connected:false', async () => {
    const { text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(makeRoomState()));
    });
    expect(text('partner-connected')).toBe('true');

    // Server marks the host disconnected, but the host's player keeps
    // reporting a moving position — they are live.
    act(() => {
      const moved = makeRoomState();
      moved.participants[0] = { ...moved.participants[0], connected: false, reportedPositionMs: 12000 };
      fire('room:state', moved);
    });
    expect(text('partner-connected')).toBe('true');

    // Their chat arrives too, still with the flag false.
    act(() => {
      const flagged = makeRoomState();
      flagged.participants[0] = { ...flagged.participants[0], connected: false, reportedPositionMs: 12000 };
      fire('room:state', flagged);
      fire('chat:message', { senderId: 'host-1', senderName: 'Host', text: 'can you hear this?' });
    });
    expect(text('partner-connected')).toBe('true');
  });

  it('partner flips to disconnected only after the flag is false AND their traffic has been silent past the grace window', async () => {
    vi.useFakeTimers();
    const { text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(makeRoomState()));
    });
    expect(text('partner-connected')).toBe('true');

    // Flag false, but the host's position advanced: fresh traffic, still connected.
    act(() => {
      const moved = makeRoomState();
      moved.participants[0] = { ...moved.participants[0], connected: false, reportedPositionMs: 12000 };
      fire('room:state', moved);
    });
    expect(text('partner-connected')).toBe('true');

    // No further traffic. Inside the 10s grace window the indicator holds…
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    expect(text('partner-connected')).toBe('true');

    // …past it, the partner is genuinely gone.
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(text('partner-connected')).toBe('false');
  });

  it('partner with flag false and no traffic at all shows disconnected', async () => {
    const { text } = mountProbe();
    act(() => {
      const state = makeRoomState();
      state.participants[0] = { ...state.participants[0], connected: false };
      fire('room:joined', joinResult(state));
    });
    expect(text('partner-connected')).toBe('false');
  });
});

describe('R3: RoomView presence display follows the derived presence', () => {
  function makeCtx(overrides = {}) {
    const rs = makeRoomState();
    rs.participants[0] = { ...rs.participants[0], connected: false, reportedPositionMs: 10000 };
    return {
      roomState: rs,
      session: { roomCode: 'UA4DVX', participantId: 'guest-1', role: 'guest', sessionToken: 'tok-guest' },
      myParticipant: rs.participants[1],
      partnerParticipant: rs.participants[0],
      partnerConnected: true,
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
        reportedPositionMs: 55000,
        expectedPositionMs: 55000,
        correctionCount: 0,
        reconnectCount: 0,
        lastSyncedAtMs: null,
      },
      syncStatus: 'waiting',
      volume: 0.85,
      muted: false,
      setVolume: vi.fn(),
      toggleMute: vi.fn(),
      getCurrentPositionMs: vi.fn().mockResolvedValue(55000),
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

  function renderRoomView(ctx) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    act(() => {
      root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView isDemo={false} onLeave={() => {}} />
        </RoomContext.Provider>
      );
    });
    return container;
  }

  it('shows Ready when derived presence is connected even though the server flag is false', async () => {
    const container = renderRoomView(makeCtx({ partnerConnected: true }));
    await act(async () => {
      await sleep(50);
    });
    expect(container.textContent).not.toContain('Disconnected — waiting to reconnect');
    expect(container.textContent).toContain('Ready');
  });

  it('shows Disconnected when derived presence is disconnected', async () => {
    const container = renderRoomView(makeCtx({ partnerConnected: false }));
    await act(async () => {
      await sleep(50);
    });
    expect(container.textContent).toContain('Disconnected — waiting to reconnect');
  });
});
