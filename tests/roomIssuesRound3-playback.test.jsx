// @vitest-environment jsdom
// Regression tests for the room-test round 3 playback issues (room UA4DVX,
// live test 2026-11-28):
//   R1 — first Play stuck on "Loading…"/"Buffering" at 00:00 for ~40s.
//   R4 — status pill / Play button showed stale server state (guest "Paused"
//        while playing; host "Buffering" while progress advanced; Play button
//        stuck on "Loading…" while progress advanced).
//   R5 — Audio Only now-playing duration showed the PREVIOUS track's length
//        (Instant Crush 04:04 vs 05:39 in the queue).
//   Extra — now-playing duration briefly showed the previous track's length
//        for 1–2s after every switch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  shouldReportRealDuration,
  resolveNowPlayingDurationSec,
  resolvePlaybackStatus,
} from '../src/utils/playbackSync.js';
import { YouTubePlayer } from '../src/players/YouTubePlayer.js';
import { RoomContext } from '../src/context/RoomContext.jsx';
import RoomView from '../src/components/RoomView.jsx';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';

const MIDNIGHT_CITY = INITIAL_TRACKS[0]; // 243s, youtubeId dX3k_QDnzHE
const INSTANT_CRUSH = INITIAL_TRACKS[1]; // 337s, youtubeId a5uQMwRMHcs

// ---------------------------------------------------------------- R5: duration reporting
describe('shouldReportRealDuration (R5)', () => {
  const base = {
    loadedId: 'a5uQMwRMHcs',
    expectedId: 'a5uQMwRMHcs',
    realDurationMs: 339000,
    storedMs: 336000,
    lastReportedMs: 0,
  };

  it('reports when the player is confirmed on the expected track', () => {
    expect(shouldReportRealDuration(base)).toBe(true);
  });

  it('refuses a duration read while the player is still on the previous track', () => {
    // Right after Next the player still holds Midnight City (243s) while
    // the room is already on Instant Crush — reporting 243s would overwrite
    // Instant Crush's duration with 04:03/04:04 server-side.
    expect(
      shouldReportRealDuration({ ...base, loadedId: 'dX3k_QDnzHE', realDurationMs: 243000 })
    ).toBe(false);
  });

  it('refuses when the loaded media is unknown', () => {
    expect(shouldReportRealDuration({ ...base, loadedId: null })).toBe(false);
  });

  it('refuses a duration within 2s of the stored one (no correction needed)', () => {
    expect(shouldReportRealDuration({ ...base, realDurationMs: 338000 })).toBe(false);
  });

  it('refuses a duration already reported (no spam)', () => {
    expect(shouldReportRealDuration({ ...base, lastReportedMs: 339000 })).toBe(false);
  });

  it('refuses a zero/unknown duration', () => {
    expect(shouldReportRealDuration({ ...base, realDurationMs: 0 })).toBe(false);
  });
});

describe('resolveNowPlayingDurationSec (R5 flicker)', () => {
  it('prefers the server playback duration — it is set atomically with the track', () => {
    // playback:state for Instant Crush (339s) lands before queue:updated, so
    // currentTrack is still Midnight City (243s): the UI must show 05:39,
    // not flash 04:03 for a moment.
    expect(
      resolveNowPlayingDurationSec({
        trackDurationSec: 243,
        playbackDurationMs: 339000,
      })
    ).toBe(339);
  });

  it('falls back to the track duration when the server duration is unknown (0)', () => {
    expect(
      resolveNowPlayingDurationSec({ trackDurationSec: 243, playbackDurationMs: 0 })
    ).toBe(243);
  });

  it('falls back to 1s when nothing is known', () => {
    expect(
      resolveNowPlayingDurationSec({ trackDurationSec: undefined, playbackDurationMs: 0 })
    ).toBe(1);
  });
});

// ---------------------------------------------------------------- R4: status derivation
describe('resolvePlaybackStatus (R4)', () => {
  const readyRoom = {
    playerState: 'playing',
    serverPlaybackState: 'playing',
    participantsBuffering: false,
    driftMs: 50,
    hasPartner: true,
    partnerReady: true,
    meReady: true,
    hasRoomState: true,
  };

  it('shows in-sync when the local player is playing and drift is small', () => {
    expect(resolvePlaybackStatus(readyRoom)).toBe('in-sync');
  });

  it('shows syncing when the local player is playing but drift is large', () => {
    expect(resolvePlaybackStatus({ ...readyRoom, driftMs: 900 })).toBe('syncing');
  });

  it('trusts the local player over a stale server "paused" (guest played while pill said Paused)', () => {
    expect(
      resolvePlaybackStatus({ ...readyRoom, serverPlaybackState: 'paused' })
    ).toBe('in-sync');
  });

  it('trusts the local player over a stale partner "buffering" flag', () => {
    expect(
      resolvePlaybackStatus({ ...readyRoom, participantsBuffering: true })
    ).toBe('in-sync');
  });

  it('treats buffering as playing when the position is advancing', () => {
    expect(
      resolvePlaybackStatus({
        ...readyRoom,
        playerState: 'buffering',
        positionAdvanced: true,
      })
    ).toBe('in-sync');
  });

  it('shows buffering when the player really is buffering (position stuck)', () => {
    expect(
      resolvePlaybackStatus({
        ...readyRoom,
        playerState: 'buffering',
        positionAdvanced: false,
      })
    ).toBe('buffering');
  });

  it('shows paused when the local player is paused, even if the server says playing', () => {
    expect(
      resolvePlaybackStatus({ ...readyRoom, playerState: 'paused' })
    ).toBe('paused');
  });

  it('waits while the partner is not ready yet', () => {
    expect(
      resolvePlaybackStatus({ ...readyRoom, partnerReady: false })
    ).toBe('waiting');
  });

  it('falls back to server state while the local player has no live state', () => {
    expect(
      resolvePlaybackStatus({ ...readyRoom, playerState: 'idle', participantsBuffering: true })
    ).toBe('buffering');
    expect(
      resolvePlaybackStatus({
        ...readyRoom,
        playerState: 'idle',
        serverPlaybackState: 'paused',
      })
    ).toBe('paused');
  });

  it('waits with no room state', () => {
    expect(resolvePlaybackStatus({ ...readyRoom, hasRoomState: false })).toBe('waiting');
  });
});

// ---------------------------------------------------------------- R1/R5: YouTubePlayer
describe('YouTubePlayer (R1 first Play, R5 stale duration)', () => {
  let capturedEvents;
  let fakePlayer;
  let videoUrl;

  beforeEach(() => {
    capturedEvents = null;
    videoUrl = '';
    fakePlayer = {
      loadVideoById: vi.fn(),
      cueVideoById: vi.fn(),
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      seekTo: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 339),
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
  });

  afterEach(() => {
    delete window.YT;
  });

  async function initPlayer(player, container) {
    const initPromise = player.initialize(container);
    // initialize() awaits the (already-loaded) IFrame API first, so the
    // fake YT.Player is only constructed on a later microtask — wait for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    capturedEvents.onReady();
    await initPromise;
  }

  function makeContainer() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  it('R1: play() on a merely-cued video force-loads it instead of calling playVideo()', async () => {
    const player = new YouTubePlayer({ onStateChange: vi.fn() });
    const container = makeContainer();
    await initPlayer(player, container);

    await player.loadTrack(MIDNIGHT_CITY, 0, false);
    expect(fakePlayer.cueVideoById).toHaveBeenCalledTimes(1);
    expect(fakePlayer.loadVideoById).not.toHaveBeenCalled();

    // First Play: the cued video has never actually played, so playVideo()
    // (the path that sat on "Buffering" at 00:00 for ~40s) must not be used.
    await player.play();
    expect(fakePlayer.loadVideoById).toHaveBeenCalledWith({
      videoId: 'dX3k_QDnzHE',
      startSeconds: 0,
    });
    expect(fakePlayer.playVideo).not.toHaveBeenCalled();

    // Once the video has actually reached PLAYING, play() uses playVideo().
    capturedEvents.onStateChange({ data: 1 }); // PLAYING
    fakePlayer.loadVideoById.mockClear();
    capturedEvents.onStateChange({ data: 2 }); // PAUSED
    await player.play();
    expect(fakePlayer.playVideo).toHaveBeenCalledTimes(1);
    expect(fakePlayer.loadVideoById).not.toHaveBeenCalled();
    container.remove();
  });

  it('R1: a play() issued before the player is ready is remembered, not dropped', async () => {
    const player = new YouTubePlayer({});
    // Track cued before init, then Play tapped while the IFrame is still loading.
    await player.loadTrack(MIDNIGHT_CITY, 0, false);
    await player.play();
    const container = makeContainer();
    await initPlayer(player, container);
    // onReady must load AND play (not cue paused) because play() was requested.
    expect(fakePlayer.loadVideoById).toHaveBeenCalledWith({
      videoId: 'dX3k_QDnzHE',
      startSeconds: 0,
    });
    expect(fakePlayer.cueVideoById).not.toHaveBeenCalled();
    container.remove();
  });

  it('R1: loadTrack for a not-yet-ready player with shouldPlay loads and plays on ready', async () => {
    const player = new YouTubePlayer({});
    await player.loadTrack(INSTANT_CRUSH, 0, true);
    const container = makeContainer();
    await initPlayer(player, container);
    expect(fakePlayer.loadVideoById).toHaveBeenCalledWith({
      videoId: 'a5uQMwRMHcs',
      startSeconds: 0,
    });
    container.remove();
  });

  it('R1: loadTrack on the same video with shouldPlay plays it (not just seeks)', async () => {
    const player = new YouTubePlayer({});
    const container = makeContainer();
    await initPlayer(player, container);
    await player.loadTrack(MIDNIGHT_CITY, 0, false);
    fakePlayer.seekTo.mockClear();
    await player.loadTrack(MIDNIGHT_CITY, 5000, true);
    expect(fakePlayer.seekTo).toHaveBeenCalledWith(5, true);
    // Never played yet, so the play must force-load rather than playVideo().
    expect(fakePlayer.loadVideoById).toHaveBeenCalled();
    container.remove();
  });

  it('R1 follow-up: repeated play() while the load is in flight must NOT re-issue loadVideoById', async () => {
    // This was the actual stall: room:state is re-broadcast ~every second,
    // and every broadcast re-ran play() — each call restarted the YouTube
    // load, so a first Play never finished buffering. A second play() while
    // the first load is still in flight must just call playVideo().
    const onStateChange = vi.fn();
    const player = new YouTubePlayer({ onStateChange });
    const container = makeContainer();
    await initPlayer(player, container);

    await player.loadTrack(MIDNIGHT_CITY, 0, false);
    await player.play();
    expect(fakePlayer.loadVideoById).toHaveBeenCalledTimes(1);
    expect(fakePlayer.playVideo).not.toHaveBeenCalled();

    // The room re-broadcasts the same playing state ~every second; each
    // re-apply calls play() again. The load must not restart.
    capturedEvents.onStateChange({ data: 3 }); // BUFFERING
    await player.play();
    await player.play();
    expect(fakePlayer.loadVideoById).toHaveBeenCalledTimes(1);
    expect(fakePlayer.playVideo).toHaveBeenCalled();

    // Once PLAYING fires, later play() calls are plain playVideo() too.
    fakePlayer.loadVideoById.mockClear();
    fakePlayer.playVideo.mockClear();
    capturedEvents.onStateChange({ data: 1 }); // PLAYING
    await player.play();
    expect(fakePlayer.loadVideoById).not.toHaveBeenCalled();
    expect(fakePlayer.playVideo).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it('R1 follow-up: after a load error, play() may force-load again', async () => {
    const player = new YouTubePlayer({ onError: vi.fn() });
    const container = makeContainer();
    await initPlayer(player, container);

    await player.loadTrack(MIDNIGHT_CITY, 0, false);
    await player.play();
    expect(fakePlayer.loadVideoById).toHaveBeenCalledTimes(1);

    // The load failed — the in-flight marker must clear so a retry works.
    capturedEvents.onError({ data: 5 });
    fakePlayer.loadVideoById.mockClear();
    await player.play();
    expect(fakePlayer.loadVideoById).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it('R1 follow-up: CUED and UNSTARTED states are reported, not swallowed', async () => {
    const onStateChange = vi.fn();
    const player = new YouTubePlayer({ onStateChange });
    const container = makeContainer();
    await initPlayer(player, container);

    capturedEvents.onStateChange({ data: 5 }); // CUED
    expect(await player.getState()).toBe('cued');
    expect(onStateChange).toHaveBeenCalledWith('cued');

    capturedEvents.onStateChange({ data: -1 }); // UNSTARTED
    expect(await player.getState()).toBe('unstarted');
    expect(onStateChange).toHaveBeenCalledWith('unstarted');
    container.remove();
  });

  it('R5: getDuration() returns 0 while the previous video is still loaded', async () => {
    const player = new YouTubePlayer({});
    const container = makeContainer();
    await initPlayer(player, container);
    await player.loadTrack(INSTANT_CRUSH, 0, true);
    // The iframe still shows the previous video's URL: duration is stale.
    videoUrl = 'https://www.youtube.com/watch?v=dX3k_QDnzHE';
    expect(await player.getDuration()).toBe(0);
    // Once the new video is actually loaded, the real duration is reported.
    videoUrl = 'https://www.youtube.com/watch?v=a5uQMwRMHcs';
    expect(await player.getDuration()).toBe(339000);
    container.remove();
  });
});

// ---------------------------------------------------------------- RoomView: duration + button
describe('RoomView duration and Play button (R4/R5)', () => {
  function makeCtx(overrides = {}) {
    const rs = {
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
      audioUnlocked: true,
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
      syncStatus: 'paused',
      playerState: 'idle',
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
      sendCommand: vi.fn().mockResolvedValue({ ok: true }),
      setPlayerError: vi.fn(),
      setRoomError: vi.fn(),
      ...overrides,
    };
  }

  function renderCtx(ctx) {
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
    return { container, root };
  }

  it('R5 flicker: when playback has moved to the next track but the queue has not, the now-playing duration is the new track’s (05:39), not the previous track’s (04:03)', () => {
    const ctx = makeCtx();
    // playback:state for Instant Crush (339s) arrived before queue:updated,
    // so currentTrack is still Midnight City (243s).
    ctx.roomState.playback = {
      playbackState: 'paused',
      positionMs: 0,
      durationMs: 339000,
      trackVersion: 2,
      trackId: 'trk-2',
    };
    const { container, root } = renderCtx(ctx);
    expect(container.textContent).toContain('05:39');
    act(() => root.unmount());
    container.remove();
  });

  it('R4: the Play button follows the local player — Pause icon while the local player plays even though the server says paused', () => {
    const ctx = makeCtx({ playerState: 'playing' });
    ctx.roomState.playback = { ...ctx.roomState.playback, playbackState: 'paused' };
    const { container, root } = renderCtx(ctx);
    expect(container.querySelector('button[aria-label="Pause"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Play"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('R4: the Play button shows Play while the local player is paused even though the server says playing', () => {
    const ctx = makeCtx({ playerState: 'paused' });
    ctx.roomState.playback = { ...ctx.roomState.playback, playbackState: 'playing' };
    const { container, root } = renderCtx(ctx);
    expect(container.querySelector('button[aria-label="Play"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
