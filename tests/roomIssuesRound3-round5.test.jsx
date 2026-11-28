// @vitest-environment jsdom
// Round 5 regressions (live preview re-test 2026-11-28, room 5JAJQ2,
// commit 8b11649):
//   (b) a new track showed the PREVIOUS track's elapsed position (00:20 /
//       00:25 / 00:36) instead of starting at 00:00 — the 1s drift loop
//       reported the still-loaded old video's position as the new track's.
//   (c) a refreshed guest's video never resumed — the post-tap re-apply
//       was swallowed by the dedup (a cued player reads as "already trying
//       to start"), so the video sat on its thumbnail until a host action
//       arrived; and while audio was locked the UI mirrored the host's
//       live position into the guest's clock, so it showed progress with
//       no actual playback.
// The duration corruption from the same re-test (Instant Crush 05:37 →
// 05:40, The Less I Know The Better 03:36 → 05:43) turned out to be wrong
// seed data, not a reporting bug: the YouTube Data API says those videos
// really are 340s and 343s long. The seed data is fixed in mockTracks.js
// and locked by the test at the bottom of this file.
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

import { RoomProvider, useRoom } from '../src/context/RoomContext.jsx';
import { emitAck } from '../src/services/socketClient';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fire(event, ...args) {
  const fns = [...(handlers[event] || [])];
  fns.forEach((fn) => fn(...args));
}

// --- Fake YouTube IFrame API (same shape as the playback tests) ---
let capturedEvents;
let fakePlayer;
let videoUrl;
let currentTimeSec;

function installFakeYT() {
  capturedEvents = null;
  videoUrl = '';
  currentTimeSec = 0;
  fakePlayer = {
    loadVideoById: vi.fn(),
    cueVideoById: vi.fn(),
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => currentTimeSec),
    getDuration: vi.fn(() => 340),
    getVideoUrl: vi.fn(() => videoUrl),
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
}

function makeRoomState(overrides = {}) {
  const now = Date.now();
  const base = {
    roomCode: '5JAJQ2',
    lifecycleState: 'active',
    roomVersion: 7,
    settings: {
      allowGuestControl: false,
      allowGuestQueue: true,
      requireApproval: false,
      theme: 'midnight',
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
        reportedPositionMs: 20000,
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
    // The room is PLAYING Instant Crush, ~20s in (the re-test's state when
    // the guest refreshed).
    currentQueueItemId: 'q-1',
    playback: {
      playbackState: 'playing',
      anchorPositionMs: 0,
      anchorServerTimeMs: now - 20000,
      effectiveAtServerMs: now - 20000,
      durationMs: 340000,
      trackVersion: 2,
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
    roomCode: '5JAJQ2',
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
      <span data-testid="reported">{ctx.syncMetrics.reportedPositionMs}</span>
      <span data-testid="expected">{ctx.syncMetrics.expectedPositionMs}</span>
      <span data-testid="audio">{String(ctx.audioUnlocked)}</span>
      <span data-testid="player-state">{ctx.playerState}</span>
      <span data-testid="sync-status">{ctx.syncStatus}</span>
      <div data-testid="player-container" />
      <button
        data-testid="init-youtube"
        onClick={() =>
          ctx.initPlayerForSource('youtube', document.querySelector('[data-testid="player-container"]'))
        }
      >
        init youtube
      </button>
      <button data-testid="unlock" onClick={() => ctx.unlockAudio()}>
        unlock
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

async function initYoutube(container) {
  await act(async () => {
    container.querySelector('[data-testid="init-youtube"]').click();
    await sleep(50);
  });
  // initialize() awaits onReady on the fresh YT.Player.
  await act(async () => {
    capturedEvents.onReady();
    await sleep(100);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(handlers)) delete handlers[key];
  fakeSocket.connected = false;
  installFakeYT();
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
  delete window.YT;
  while (mounted.length) {
    const { container, root } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
});

describe('Round 5 (b): a new track starts at its own position, not the old video’s', () => {
  it('while the player still holds the previous video, the reported position is the new track’s expected position', async () => {
    const state = makePlayingRoomState();
    // The player still shows Midnight City (old video) at 00:36 — the new
    // video (Instant Crush) has not finished loading yet.
    videoUrl = 'https://www.youtube.com/watch?v=dX3k_QDnzHE';
    currentTimeSec = 36;
    const { container, text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(state));
    });
    await initYoutube(container);
    // The new video is still loading.
    await act(async () => {
      capturedEvents.onStateChange({ data: 3 }); // BUFFERING
      await sleep(50);
    });
    // Unlock so the 1s drift loop runs. The loop's first tick lands ~1s
    // after the unlock; allow ~2s so the tick has fired AND its state
    // update has flushed before asserting (a shorter sleep reads the
    // pre-loop seed value and the test passes vacuously).
    await act(async () => {
      container.querySelector('[data-testid="unlock"]').click();
      await sleep(300);
    });
    await act(async () => {
      await sleep(1700);
    });
    const reported = Number(text('reported'));
    const expected = Number(text('expected'));
    // The new track is ~21–22s in on the room clock. It must NOT show the
    // old video's 00:36.
    expect(Math.abs(reported - expected)).toBeLessThan(3000);
    expect(reported).toBeLessThan(30000);
  });
});

describe('Round 5 (c): a refreshed guest’s video resumes on the unlock tap', () => {
  it('unlocking audio force-applies playback so the cued player actually starts', async () => {
    const state = makePlayingRoomState();
    // The new video is loaded in the player.
    videoUrl = 'https://www.youtube.com/watch?v=a5uQMwRMHcs';
    currentTimeSec = 20;
    const { container, text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(state));
    });
    await initYoutube(container);
    // The room is playing but audio is locked: the pre-tap apply loads the
    // video and leaves the player cued on its thumbnail (a blocked
    // loadVideoById reports CUED; UNSTARTED behaves identically here).
    await act(async () => {
      capturedEvents.onStateChange({ data: 5 }); // CUED
      await sleep(50);
    });
    expect(text('audio')).toBe('false');
    expect(text('player-state')).toBe('cued');
    fakePlayer.playVideo.mockClear();
    fakePlayer.loadVideoById.mockClear();
    await act(async () => {
      container.querySelector('[data-testid="unlock"]').click();
      await sleep(300);
    });
    // Before the fix the dedup swallowed this re-apply (a cued player
    // reads as "already trying to start") and the video sat on its
    // thumbnail until a host action arrived with a new signature. The tap
    // must start the player: play() on a load already in flight just
    // calls playVideo().
    expect(fakePlayer.playVideo).toHaveBeenCalled();
  });

  it('in a PLAYING room, a locked guest’s reported position stays frozen instead of following the host', async () => {
    const state = makePlayingRoomState();
    const { text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(state));
    });
    const seedReported = Number(text('reported'));
    const seedExpected = Number(text('expected'));
    await act(async () => {
      await sleep(2200);
    });
    const reported = Number(text('reported'));
    const expected = Number(text('expected'));
    // The room advanced ~2s; the locked guest's reported position must
    // not have moved with it (before the fix the pre-unlock mirror copied
    // the host's live position into the guest's clock while its video sat
    // on its thumbnail). The read-only bar still follows the room via the
    // expected position.
    expect(expected - seedExpected).toBeGreaterThan(1500);
    expect(reported - seedReported).toBeLessThan(500);
  });

  it('in a PAUSED room, a locked guest still sees the paused position (R6 preserved)', async () => {
    const state = makePlayingRoomState();
    state.playback = {
      playbackState: 'paused',
      anchorPositionMs: 55000,
      anchorServerTimeMs: Date.now(),
      durationMs: 340000,
      trackVersion: 2,
    };
    const { text } = mountProbe();
    act(() => {
      fire('room:joined', joinResult(state));
    });
    await act(async () => {
      await sleep(1200);
    });
    expect(text('reported')).toBe('55000');
    expect(text('expected')).toBe('55000');
  });
});

describe('Round 5 (a): seed durations are the true YouTube video lengths', () => {
  it('INITIAL_TRACKS durations match the videos that actually play', () => {
    // Verified against the YouTube Data API 2026-11-28. The old values
    // were song lengths, so the player's real-duration correction
    // overwrote them after every play and the queue looked corrupted.
    expect(INITIAL_TRACKS.map((t) => [t.id, t.durationSec])).toEqual([
      ['trk-1', 244],
      ['trk-2', 340],
      ['trk-3', 343],
      ['trk-4', 274],
      ['trk-5', 213],
    ]);
  });
});

function makePlayingRoomState() {
  return makeRoomState();
}
