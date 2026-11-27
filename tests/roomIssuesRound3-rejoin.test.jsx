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
import { backgroundAudio } from '../src/utils/backgroundAudio';
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
  const [cmdResult, setCmdResult] = React.useState('');
  return (
    <div>
      <span data-testid="partner-connected">{String(ctx.partnerConnected)}</span>
      <span data-testid="reported">{ctx.syncMetrics.reportedPositionMs}</span>
      <span data-testid="expected">{ctx.syncMetrics.expectedPositionMs}</span>
      <span data-testid="theme">{ctx.roomState?.settings?.theme || ''}</span>
      <span data-testid="sync-status">{ctx.syncStatus}</span>
      <span data-testid="player-error">{ctx.playerError?.code || ''}</span>
      <button data-testid="unlock" onClick={ctx.unlockAudio}>unlock</button>
      <span data-testid="audio">{String(ctx.audioUnlocked)}</span>
      <span data-testid="room-error">{ctx.roomError || ''}</span>
      <span data-testid="cmd-result">{cmdResult}</span>
      <div data-testid="player-container" />
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
      <button
        data-testid="send-chat"
        onClick={async () => {
          const res = await ctx.sendCommand('chat:send', { text: 'hi' });
          setCmdResult(res?.ok ? 'ok' : res?.code || 'fail');
        }}
      >
        send chat
      </button>
      <button
        data-testid="init-youtube"
        onClick={() =>
          ctx.initPlayerForSource('youtube', document.querySelector('[data-testid="player-container"]'))
        }
      >
        init youtube
      </button>
      <button
        data-testid="init-audio"
        onClick={() =>
          ctx.initPlayerForSource('audio', document.querySelector('[data-testid="player-container"]'))
        }
      >
        init audio
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

it('measures drift through frequent room updates and freezes progress on a failed video', async () => {
  vi.useFakeTimers();
  const unlock = vi.spyOn(backgroundAudio, 'unlock').mockResolvedValue();
  let events;
  let position = 35;
  const fakePlayer = {
    loadVideoById: vi.fn(),
    playVideo: vi.fn(),
    seekTo: vi.fn(),
    setVolume: vi.fn(),
    getCurrentTime: () => position,
    getDuration: () => 250,
    getVideoUrl: () => `https://www.youtube.com/watch?v=${INITIAL_TRACKS[0].youtubeId}`,
  };
  vi.stubGlobal('YT', {
    PlayerState: { PLAYING: 1 },
    Player: function (_element, config) {
      events = config.events;
      queueMicrotask(() => events.onReady());
      return fakePlayer;
    },
  });

  try {
    const state = makeRoomState();
    state.participants[1].ready = true;
    state.participants[0].driftMs = 0;
    state.playback = {
      ...state.playback,
      trackId: INITIAL_TRACKS[0].id,
      playbackState: 'playing',
      anchorPositionMs: 10000,
      anchorServerTimeMs: Date.now(),
    };
    const { container, text } = mountProbe();
    await act(async () => fire('room:joined', joinResult(state)));
    await act(async () => container.querySelector('[data-testid="init-youtube"]').click());
    await act(async () => container.querySelector('[data-testid="unlock"]').click());
    await act(async () => events.onStateChange({ data: 1 }));

    for (let i = 0; i < 4; i += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(250));
      await act(async () => fire('room:state', { ...state, playback: { ...state.playback } }));
    }
    expect(fakePlayer.seekTo).toHaveBeenLastCalledWith(11, true);
    expect(text('reported')).toBe('35000');
    expect(text('sync-status')).toBe('syncing');

    await act(async () => events.onError({ data: 150 }));
    position = 80;
    emitAck.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(text('reported')).toBe('35000');
    expect(text('sync-status')).toBe('error');
    expect(text('player-error')).toBe('150');
    expect(emitAck.mock.calls.some(([event]) => event === 'player:duration')).toBe(false);
  } finally {
    unlock.mockRestore();
    vi.unstubAllGlobals();
  }
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

describe('F2: sendCommand survives the refresh / reconnect adoption race', () => {
  function mockRoomCalls(state) {
    emitAck.mockImplementation((event) => {
      if (event === 'room:join') return Promise.resolve(joinResult(state));
      if (event === 'room:reconnect') return Promise.resolve(joinResult(state));
      if (event === 'sync:request') return Promise.resolve({ ok: true, state });
      if (event === 'sync:ping') {
        const now = Date.now();
        return Promise.resolve({ ok: true, serverReceivedAtMs: now, serverSentAtMs: now });
      }
      return Promise.resolve({ ok: true });
    });
  }

  async function joinAsGuest(container) {
    await act(async () => {
      container.querySelector('[data-testid="join"]').click();
      await sleep(700);
    });
  }

  it('retries once on a membership error and succeeds — the message is not lost', async () => {
    const state = makeRoomState();
    mockRoomCalls(state);
    const { container, text } = mountProbe();
    await joinAsGuest(container);

    // The first chat:send lands before the server adopts the socket (the
    // refresh race); the retry must succeed and the error must clear.
    let chatAttempts = 0;
    emitAck.mockImplementation((event) => {
      if (event === 'chat:send') {
        chatAttempts += 1;
        if (chatAttempts === 1) {
          return Promise.resolve({ ok: false, code: 'NOT_IN_ROOM', error: 'Not joined to a room' });
        }
        return Promise.resolve({ ok: true });
      }
      if (event === 'sync:ping') {
        const now = Date.now();
        return Promise.resolve({ ok: true, serverReceivedAtMs: now, serverSentAtMs: now });
      }
      return Promise.resolve({ ok: true });
    });
    await act(async () => {
      container.querySelector('[data-testid="send-chat"]').click();
      await sleep(1600);
    });
    expect(chatAttempts).toBe(2);
    expect(text('cmd-result')).toBe('ok');
    expect(text('room-error')).toBe('');
  });

  it('a genuine permission error is NOT retried and keeps its own message', async () => {
    const state = makeRoomState();
    mockRoomCalls(state);
    const { container, text } = mountProbe();
    await joinAsGuest(container);

    let attempts = 0;
    emitAck.mockImplementation((event) => {
      if (event === 'chat:send') {
        attempts += 1;
        return Promise.resolve({
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Only the host can control playback',
        });
      }
      if (event === 'sync:ping') {
        const now = Date.now();
        return Promise.resolve({ ok: true, serverReceivedAtMs: now, serverSentAtMs: now });
      }
      return Promise.resolve({ ok: true });
    });
    await act(async () => {
      container.querySelector('[data-testid="send-chat"]').click();
      await sleep(1600);
    });
    expect(attempts).toBe(1);
    expect(text('cmd-result')).toBe('UNAUTHORIZED');
    expect(text('room-error')).toBe('Only the host can control playback');
  });

  it('waits for re-adoption after a socket drop instead of failing the command', async () => {
    const state = makeRoomState();
    mockRoomCalls(state);
    const { container, text } = mountProbe();
    await joinAsGuest(container);

    // The socket drops mid-room: the socket is no longer adopted.
    act(() => {
      fire('disconnect');
    });
    // A chat sent now must WAIT for the re-adoption — nothing emitted yet.
    act(() => {
      container.querySelector('[data-testid="send-chat"]').click();
    });
    await act(async () => {
      await sleep(400);
    });
    expect(emitAck.mock.calls.filter((c) => c[0] === 'chat:send')).toHaveLength(0);
    expect(text('cmd-result')).toBe('');
    // The socket reconnects; onConnect re-adopts via room:reconnect.
    act(() => {
      fire('connect');
    });
    await act(async () => {
      await sleep(700);
    });
    expect(emitAck.mock.calls.filter((c) => c[0] === 'chat:send')).toHaveLength(1);
    expect(text('cmd-result')).toBe('ok');
  });
});

describe('F2: a failed chat send keeps the typed text', () => {
  function makeCtx(overrides = {}) {
    const rs = makeRoomState();
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
      audioUnlocked: true,
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
      sendCommand: vi.fn().mockResolvedValue({
        ok: false,
        code: 'NOT_IN_ROOM',
        error: 'Not joined to a room',
      }),
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

  it('keeps the typed message when the send fails, so the user can retry', async () => {
    const ctx = makeCtx();
    const container = renderRoomView(ctx);
    await act(async () => {
      await sleep(50);
    });
    // Open the Chat tab — the form only renders there.
    const chatTab = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'Chat'
    );
    expect(chatTab).toBeTruthy();
    act(() => {
      chatTab.click();
    });
    const input = container.querySelector('input[aria-label="Chat message"]');
    expect(input).not.toBeNull();
    // Type into the controlled input (native setter + input event).
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => {
      setter.call(input, 'hello after refresh');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('hello after refresh');
    // Submit; the send fails (membership error) — the text must stay.
    await act(async () => {
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await sleep(50);
    });
    expect(ctx.sendCommand).toHaveBeenCalledWith('chat:send', { text: 'hello after refresh' });
    expect(input.value).toBe('hello after refresh');
  });

  it('clears the text when the send succeeds', async () => {
    const ctx = makeCtx({ sendCommand: vi.fn().mockResolvedValue({ ok: true }) });
    const container = renderRoomView(ctx);
    await act(async () => {
      await sleep(50);
    });
    const chatTab = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'Chat'
    );
    act(() => {
      chatTab.click();
    });
    const input = container.querySelector('input[aria-label="Chat message"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => {
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await sleep(50);
    });
    expect(input.value).toBe('');
  });
});

describe('Small fix: Audio Only re-emits player:ready on a seamless switch', () => {
  let capturedEvents;

  beforeEach(() => {
    capturedEvents = null;
    const fakePlayer = {
      loadVideoById: vi.fn(),
      cueVideoById: vi.fn(),
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      seekTo: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 243),
      getVideoUrl: vi.fn(() => ''),
      getVolume: vi.fn(() => 85),
      setVolume: vi.fn(),
      mute: vi.fn(),
      unMute: vi.fn(),
      destroy: vi.fn(),
    };
    window.YT = {
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      Player: vi.fn(function (el, config) {
        capturedEvents = config.events;
        return fakePlayer;
      }),
    };
  });

  afterEach(() => {
    delete window.YT;
  });

  it('switching youtube -> audio on the same player re-emits player:ready', async () => {
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
    const { container } = mountProbe();
    await act(async () => {
      container.querySelector('[data-testid="join"]').click();
      await sleep(700);
    });

    // Initialise the YouTube player (fires onReady -> player:ready #1).
    await act(async () => {
      container.querySelector('[data-testid="init-youtube"]').click();
      await sleep(50);
    });
    act(() => {
      capturedEvents.onReady();
    });
    await act(async () => {
      await sleep(50);
    });
    const readyCalls = () => emitAck.mock.calls.filter((c) => c[0] === 'player:ready');
    expect(readyCalls()).toHaveLength(1);

    // Switch to Audio Only: the same instance is kept (seamless switch),
    // so no onReady fires — but player:ready must still be re-emitted,
    // otherwise the server keeps ready=false and both tabs show
    // "Waiting for partner" while playing.
    await act(async () => {
      container.querySelector('[data-testid="init-audio"]').click();
      await sleep(50);
    });
    expect(readyCalls()).toHaveLength(2);
    expect(readyCalls()[1][1]).toEqual({ ready: true });
  });
});
