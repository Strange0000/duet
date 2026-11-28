// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomProvider, useRoom } from '../src/context/RoomContext.jsx';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';
import { emitAck } from '../src/services/socketClient.js';

const socket = vi.hoisted(() => {
  const listeners = new Map();
  return {
    connected: true,
    id: 'socket-1',
    on(event, listener) { listeners.set(event, listener); },
    off(event) { listeners.delete(event); },
    receive(event) { listeners.get(event)?.(); },
    volatile: { emit() {} },
  };
});

vi.mock('../src/services/socketClient.js', () => ({
  getSocket: () => socket,
  emitAck: vi.fn(),
}));

const track = INITIAL_TRACKS[0];
const trackId = track.youtubeId;

describe('iPhone room playback recovery', () => {
  let latest;
  let container;
  let root;
  let iframe;
  let events;
  let fraction;
  let position;
  let iframeState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone) AppleWebKit Safari');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fraction = 0;
    position = 0;
    iframeState = 5;
    iframe = {
      cueVideoById: vi.fn(),
      loadVideoById: vi.fn(({ startSeconds }) => {
        position = startSeconds;
        iframeState = 3;
      }),
      getVideoUrl: () => `https://www.youtube.com/watch?v=${trackId}`,
      getPlayerState: () => iframeState,
      getVideoLoadedFraction: () => fraction,
      getCurrentTime: () => position,
      setVolume: vi.fn(),
      destroy: vi.fn(),
    };
    window.YT = {
      PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5, ENDED: 0, UNSTARTED: -1 },
      Player: function (_mount, options) {
        events = options.events;
        Promise.resolve().then(() => events.onReady());
        return iframe;
      },
    };
    const now = Date.now();
    const state = {
      roomCode: 'GUEST1',
      roomVersion: 1,
      participants: [{ id: 'guest', role: 'guest', connected: true, source: 'youtube' }],
      queue: [{ queueItemId: 'item', track }],
      currentQueueItemId: 'item',
      playback: { trackVersion: 1, playbackState: 'playing', durationMs: 240000, anchorServerTimeMs: now },
    };
    emitAck.mockImplementation(async (event) => {
      if (event === 'room:join') {
        return { ok: true, roomCode: state.roomCode, participantId: 'guest', sessionToken: 'token', role: 'guest', state };
      }
      if (event === 'sync:request') return { ok: true, state };
      if (event === 'sync:ping') return { ok: true, serverReceivedAtMs: Date.now(), serverSentAtMs: Date.now() };
      return { ok: true };
    });

    function Listener() {
      latest = useRoom();
      const playerContainer = useRef(null);
      const { roomState, initPlayerForSource } = latest;
      const roomCode = roomState?.roomCode;
      useEffect(() => {
        if (roomCode) initPlayerForSource('youtube', playerContainer.current);
      }, [roomCode, initPlayerForSource]);
      return <div ref={playerContainer} />;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<RoomProvider><Listener /></RoomProvider>));
  });

  afterEach(async () => {
    await act(async () => latest.leaveRoom());
    act(() => root.unmount());
    container.remove();
    delete window.YT;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const tick = async (ms) => act(async () => vi.advanceTimersByTimeAsync(ms));
  const join = () => act(async () => latest.joinRoom({ roomCode: 'GUEST1' }));

  it('clears the room and stops the player when a reconnect is rejected', async () => {
    await join();
    expect(latest.roomState?.roomCode).toBe('GUEST1');
    const originalAck = emitAck.getMockImplementation();
    emitAck.mockImplementation((event, ...args) => event === 'room:reconnect'
      ? Promise.resolve({ ok: false, code: 'INVALID_SESSION' })
      : originalAck(event, ...args));

    await act(async () => {
      socket.receive('disconnect');
      socket.receive('connect');
    });

    expect(latest.roomState).toBeNull();
    expect(latest.session).toBeNull();
    expect(latest.roomError).toMatch(/session expired/i);
    expect(sessionStorage.getItem('duet_active_session')).toBeNull();
    expect(iframe.destroy).toHaveBeenCalledOnce();
  });

  it('starts syncing after a native play even if the iframe event is missed', async () => {
    await join();
    expect(latest.audioUnlocked).toBe(false);
    expect(iframe.cueVideoById).toHaveBeenCalledOnce();

    iframeState = 1;
    await tick(1000);

    expect(latest.audioUnlocked).toBe(true);
    expect(latest.playerState).toBe('playing');
    expect(iframe.loadVideoById).not.toHaveBeenCalled();
  });

  it('lets the buffer fill, restarts once if it stops progressing, then offers recovery', async () => {
    await join();
    await act(async () => latest.unlockAudio());
    expect(iframe.loadVideoById).toHaveBeenCalledOnce();

    fraction = 0.2;
    await tick(12000);
    expect(iframe.loadVideoById).toHaveBeenCalledOnce();
    await tick(12000);
    expect(iframe.loadVideoById).toHaveBeenCalledTimes(2);
    expect(iframe.loadVideoById.mock.lastCall[0].startSeconds).toBeGreaterThan(0);
    await tick(24000);
    expect(latest.playerError?.code).toBe('PLAY_STALLED');
    expect(iframe.loadVideoById).toHaveBeenCalledTimes(2);
  });
});
