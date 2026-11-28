// @vitest-environment jsdom
// Regression test: RoomView must render a real room without throwing.
// (PR #4 preview crashed on every room load because useCallback was used
// in RoomView.jsx without being imported — the ErrorBoundary caught it.)
// Renders RoomView with a hand-built RoomContext value that mimics a real
// room (host only, queue with INITIAL_TRACKS) and reports the actual error.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RoomContext } from '../src/context/RoomContext.jsx';
import RoomView from '../src/components/RoomView.jsx';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';

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

describe('RoomView renders a real room', () => {
  it('renders a real room (host only) without throwing', () => {
    const ctx = makeCtx();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let caught = null;
    try {
      act(() => {
        root.render(
          <RoomContext.Provider value={ctx}>
            <RoomView isDemo={false} onLeave={() => {}} />
          </RoomContext.Provider>
        );
      });
    } catch (e) {
      caught = e;
    }
    if (caught) {
      console.log('ROOM CRASH ERROR:', caught.message);
      console.log(caught.stack);
    }
    expect(caught).toBeNull();
    expect(container.textContent).toContain('Midnight City');
    act(() => root.unmount());
    container.remove();
  });

  // Round 5: after a refresh the guest's player cues at the room position
  // but cannot play until the audio-unlock tap — it sits on the video
  // thumbnail while the server still says "playing". The button must show
  // Play (not Pause) for a silent tab.
  it('shows Play (not Pause) for a cued player while audio is still locked', () => {
    const ctx = makeCtx({ playerState: 'cued', audioUnlocked: false });
    ctx.roomState.playback.playbackState = 'playing';
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
    expect(container.querySelector('button[aria-label="Play"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Pause"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('shows Pause for a cued player once audio is unlocked (still loading)', () => {
    const ctx = makeCtx({ playerState: 'cued', audioUnlocked: true });
    ctx.roomState.playback.playbackState = 'playing';
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
    expect(container.querySelector('button[aria-label="Pause"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Play"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
