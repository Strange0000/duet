// @vitest-environment jsdom
// Regression test: RoomView must render a real room without throwing.
// (PR #4 preview crashed on every room load because useCallback was used
// in RoomView.jsx without being imported — the ErrorBoundary caught it.)
// Renders RoomView with a hand-built RoomContext value that mimics a real
// room (host only, queue with INITIAL_TRACKS) and reports the actual error.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RoomContext } from '../src/context/RoomContext.jsx';
import RoomView from '../src/components/RoomView.jsx';
import { INITIAL_TRACKS } from '../src/data/mockTracks.js';

vi.mock('../src/components/AudioVisualizerCanvas.jsx', () => ({ default: () => null }));

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

  it('directs an iPhone guest to the native YouTube Play control', () => {
    const ctx = makeCtx({ audioUnlocked: false, session: { participantId: 'guest-1', role: 'guest' } });
    ctx.roomState.playback.playbackState = 'playing';
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    const original = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone) AppleWebKit Safari' });

    try {
      act(() => root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView onLeave={() => {}} />
        </RoomContext.Provider>
      ));
      expect(container.querySelector('.room-stage').textContent).toContain('Tap Play inside the YouTube video');
      expect(container.textContent).not.toContain('Tap to Join Audio');
    } finally {
      act(() => root.unmount());
      container.remove();
      if (original) Object.defineProperty(navigator, 'userAgent', original);
      else delete navigator.userAgent;
    }
  });

  it('starts YouTube in the mobile Play tap and rolls back if the room rejects it', async () => {
    const cancelLocalStart = vi.fn();
    const startYouTubeFromGesture = vi.fn(() => cancelLocalStart);
    const sendCommand = vi.fn().mockResolvedValue({ ok: false });
    const ctx = makeCtx({ startYouTubeFromGesture, sendCommand });
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));

    try {
      act(() => root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView onLeave={() => {}} />
        </RoomContext.Provider>
      ));
      await act(async () => {
        container.querySelector('.room-play').click();
        expect(startYouTubeFromGesture).toHaveBeenCalledWith(0);
        expect(startYouTubeFromGesture.mock.invocationCallOrder[0]).toBeLessThan(sendCommand.mock.invocationCallOrder[0]);
      });
      expect(cancelLocalStart).toHaveBeenCalledOnce();
      expect(ctx.getCurrentPositionMs).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      window.matchMedia = originalMatchMedia;
    }
  });

  it('lists the first received chat message and opens chat from the notification', () => {
    const ctx = makeCtx();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    const render = (roomState) => act(() => root.render(
      <RoomContext.Provider value={{ ...ctx, roomState }}>
        <RoomView onLeave={() => {}} />
      </RoomContext.Provider>
    ));

    try {
      render(ctx.roomState);
      act(() => container.querySelector('[aria-label="Notifications"]').click());
      expect(container.querySelector('.room-notifications').textContent).toContain('No new notifications');

      const message = { id: 'first-chat', senderId: 'guest-1', senderName: 'Guest', text: 'First message' };
      render({ ...ctx.roomState, chat: [message] });
      render({ ...ctx.roomState, chat: [message] });
      const notification = container.querySelector('.room-notifications .max-h-64 button');
      expect(notification.textContent).toContain('First message');
      expect(container.querySelectorAll('.room-notifications .max-h-64 button')).toHaveLength(1);
      act(() => notification.click());
      expect(container.querySelector('[aria-label="Chat message"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('toggles the glass appearance independently of room settings and persists it', () => {
    const ctx = makeCtx();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    localStorage.removeItem('duet_room_glass');

    try {
      act(() => root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView onLeave={() => {}} />
        </RoomContext.Provider>
      ));
      act(() => container.querySelector('[aria-label="Room settings"]').click());
      const toggle = container.querySelector('.room-glass-toggle');
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(container.querySelector('.duet-room').dataset.glass).toBe('on');
      expect(localStorage.getItem('duet_room_glass')).toBe('on');
      expect(ctx.sendCommand).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      localStorage.removeItem('duet_room_glass');
    }
  });

  it('keeps queue additions separate from guest playback and connection permissions', () => {
    const ctx = makeCtx({ session: { participantId: 'guest-1', role: 'guest' } });
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    const render = (canAdd, connectionStatus = 'connected') => act(() => root.render(
      <RoomContext.Provider value={{
        ...ctx,
        connectionStatus,
        roomState: {
          ...ctx.roomState,
          settings: { ...ctx.roomState.settings, allowGuestControl: false, allowGuestQueue: canAdd },
        },
      }}>
        <RoomView onLeave={() => {}} />
      </RoomContext.Provider>
    ));

    try {
      render(false);
      const addTab = [...container.querySelectorAll('.room-desktop-tabs button')].find((button) => button.textContent === 'Add');
      act(() => addTab.click());
      expect(container.querySelector('.room-search-result button').disabled).toBe(true);
      expect(container.querySelector('.room-play').disabled).toBe(true);

      render(true);
      expect(container.querySelector('.room-search-result button').disabled).toBe(false);
      expect(container.querySelector('.room-play').disabled).toBe(true);

      render(true, 'reconnecting');
      expect(container.querySelector('.room-search-result button').disabled).toBe(true);
      expect(container.querySelector('.room-permission-note').textContent).toContain('reconnects');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('transfers hosting to the avatar selected in the lobby', async () => {
    const ctx = makeCtx();
    const host = ctx.roomState.participants[0];
    const guests = [
      { ...host, id: 'guest-1', name: 'First guest', role: 'guest' },
      { ...host, id: 'guest-2', name: 'Second guest', role: 'guest' },
      { ...host, id: 'guest-3', name: 'Offline guest', role: 'guest', connected: false },
    ];
    ctx.roomState.participants.push(...guests);
    ctx.partnerParticipant = guests[0];
    ctx.sendCommand.mockResolvedValue({ ok: true, state: { participants: [{ ...guests[1], role: 'host' }] } });
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    const render = (value) => act(() => root.render(
      <RoomContext.Provider value={value}>
        <RoomView onLeave={() => {}} />
      </RoomContext.Provider>
    ));

    try {
      render(ctx);
      const lobby = [...container.querySelectorAll('.room-desktop-tabs button')].find((button) => button.textContent === 'Lobby');
      act(() => lobby.click());
      expect(container.querySelector('[aria-label="Make Offline guest host"]')).toBeNull();
      act(() => container.querySelector('[aria-label="Make Second guest host"]').click());
      expect(container.querySelector('dialog[open]').textContent).toContain('Make Second guest host?');
      expect(ctx.sendCommand).not.toHaveBeenCalled();

      await act(async () => container.querySelector('dialog [data-tone="primary"]').click());
      expect(ctx.sendCommand).toHaveBeenCalledWith('room:transfer-host', { targetParticipantId: 'guest-2' });
      expect(container.querySelector('dialog[open]')).toBeNull();

      render({ ...ctx, session: { ...ctx.session, role: 'guest' } });
      expect(container.querySelectorAll('button.room-lobby-avatar')).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows every participant in a six-person lobby', () => {
    const ctx = makeCtx();
    const guest = ctx.roomState.participants[0];
    ctx.roomState.participants = [guest, ...Array.from({ length: 5 }, (_, index) => ({
      ...guest,
      id: `guest-${index + 1}`,
      name: `Guest ${index + 1}`,
      role: 'guest',
    }))];
    ctx.partnerParticipant = ctx.roomState.participants[1];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      act(() => root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView onLeave={() => {}} />
        </RoomContext.Provider>
      ));
      const lobbyButton = [...container.querySelectorAll('.room-desktop-tabs button')]
        .find((button) => button.textContent === 'Lobby');
      act(() => lobbyButton.click());
      expect(container.querySelectorAll('.room-lobby-person')).toHaveLength(6);
      expect(container.querySelector('.room-lobby').textContent).toContain('Guest 5');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('inherits light mode while exposing all six shared room themes', () => {
    const ctx = makeCtx();
    ctx.roomState.settings.theme = 'ocean';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    localStorage.setItem('duet_home_theme', 'light');

    try {
      act(() => root.render(
        <RoomContext.Provider value={ctx}>
          <RoomView onLeave={() => {}} />
        </RoomContext.Provider>
      ));
      expect(container.querySelector('.duet-room').dataset.appearance).toBe('light');
      expect(container.querySelector('.room-ambient').dataset.theme).toBe('ocean');
      act(() => container.querySelector('.room-theme-trigger').click());
      const options = container.querySelector('#room-theme-options');
      expect(options.hidden).toBe(false);
      expect(options.querySelectorAll('.room-theme-swatch')).toHaveLength(6);
      expect(options.querySelector('[aria-pressed="true"]').textContent).toContain('Deep Ocean');
    } finally {
      act(() => root.unmount());
      container.remove();
      localStorage.removeItem('duet_home_theme');
    }
  });

  it.each(['audio', 'local'])('omits the video mount for %s and restores it for YouTube', (source) => {
    const ctx = makeCtx();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderSource = (nextSource) => {
      act(() => root.render(
        <RoomContext.Provider value={{
          ...ctx,
          myParticipant: { ...ctx.myParticipant, source: nextSource },
        }}>
          <RoomView onLeave={() => {}} />
        </RoomContext.Provider>
      ));
    };

    try {
      renderSource(source);
      expect(container.querySelector('.room-video')).toBeNull();
      expect(ctx.initPlayerForSource).toHaveBeenLastCalledWith(source, null);
      expect(container.textContent).not.toContain('Audio Only plays synced test tones.');

      renderSource('youtube');
      expect(container.querySelector('.room-video')).not.toBeNull();
      expect(ctx.initPlayerForSource).toHaveBeenLastCalledWith('youtube', expect.any(HTMLElement));
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('invite share', () => {
  const origShare = Object.getOwnPropertyDescriptor(navigator, 'share');
  const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  function renderRoom() {
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
    return { container, root };
  }

  function shareButton(container) {
    return container.querySelector('button[aria-label="Share invite link"], button[aria-label="Invite link copied"]');
  }

  afterEach(() => {
    if (origShare) Object.defineProperty(navigator, 'share', origShare);
    else delete navigator.share;
    if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
    else delete navigator.clipboard;
  });

  it('opens the native share sheet with the invite link when navigator.share exists', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, root } = renderRoom();
    try {
      await act(async () => { shareButton(container).click(); });
      expect(share).toHaveBeenCalledTimes(1);
      expect(share).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Duet — listen together',
        url: expect.stringContaining('/room/TEST01'),
      }));
      expect(share.mock.calls[0][0].text).toContain('TEST01');
      expect(share.mock.calls[0][0].text).toContain('Midnight City');
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('offers share targets when navigator.share is missing', async () => {
    delete navigator.share;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, root } = renderRoom();
    try {
      await act(async () => { shareButton(container).click(); });
      expect(writeText).not.toHaveBeenCalled();
      const dialog = container.querySelector('dialog[open]');
      expect(dialog.querySelector('a[href^="https://wa.me/"]')).not.toBeNull();
      expect(dialog.querySelector('a[href^="mailto:"]')).not.toBeNull();
      expect(dialog.querySelector('input').value).toContain('/room/TEST01');
      expect(container.querySelector('dialog[open]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('does nothing when the user dismisses the share sheet', async () => {
    const abort = new Error('Share cancelled');
    abort.name = 'AbortError';
    const share = vi.fn().mockRejectedValue(abort);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, root } = renderRoom();
    try {
      await act(async () => { shareButton(container).click(); });
      expect(writeText).not.toHaveBeenCalled();
      expect(container.querySelector('dialog[open]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('offers share targets when native sharing fails', async () => {
    const share = vi.fn().mockRejectedValue(new Error('Share failed'));
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, root } = renderRoom();
    try {
      await act(async () => { shareButton(container).click(); });
      expect(writeText).not.toHaveBeenCalled();
      const dialog = container.querySelector('dialog[open]');
      expect(dialog.querySelector('a[href^="https://wa.me/"]')).not.toBeNull();
      expect(dialog.querySelector('a[href^="mailto:"]')).not.toBeNull();
      expect(dialog.querySelector('input').value).toContain('/room/TEST01');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
