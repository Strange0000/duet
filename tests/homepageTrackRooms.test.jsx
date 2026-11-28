// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useRoom } from '../src/context/RoomContext.jsx';
import { emitAck } from '../src/services/socketClient.js';
import { trackSchema } from '../server/src/validators/events.js';

vi.mock('../src/services/socketClient.js', () => ({
  getSocket: () => ({ connected: true, on() {}, off() {} }),
  generateCommandId: () => 'test-command',
  emitAck: vi.fn(),
}));

vi.mock('../src/utils/artworkApi.js', () => ({
  fetchSongArtwork: async () => null,
}));

vi.mock('../src/components/RoomView.jsx', () => ({
  default: function RoomPreview({ isDemo }) {
    const { currentTrack } = useRoom();
    return <h1>{isDemo ? 'Demo' : currentTrack?.title}</h1>;
  },
}));

it('starts a shareable room on the exact track selected on the homepage', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('YT', { Player: vi.fn() });
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');

  emitAck.mockImplementation(async (event, payload) => {
    if (event === 'room:create') {
      expect(payload.initialTracks).toHaveLength(1);
      const track = trackSchema.parse(payload.initialTracks[0]);
      return {
        ok: true,
        roomCode: 'TRACK2',
        participantId: 'host',
        sessionToken: 'token',
        role: 'host',
        state: {
          roomCode: 'TRACK2',
          roomVersion: 1,
          participants: [{ id: 'host', role: 'host', connected: true, source: 'youtube' }],
          currentQueueItemId: 'queue-entry',
          queue: [{ queueItemId: 'queue-entry', track }],
          playback: { playbackState: 'paused', trackVersion: 1, durationMs: track.durationSec * 1000 },
        },
      };
    }
    if (event === 'player:play') return { ok: true };
    return { ok: false };
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => vi.dynamicImportSettled());

    const cards = [...container.querySelectorAll('.home-shelf-track')];
    expect(cards).toHaveLength(10);
    const selected = cards.find((button) => button.getAttribute('aria-label').startsWith('Play Blinding Lights'));
    await act(async () => selected.click());
    await act(async () => vi.dynamicImportSettled());

    expect(emitAck).toHaveBeenCalledWith('room:create', {
      name: 'Host',
      source: 'youtube',
      initialTracks: [expect.objectContaining({ title: 'Blinding Lights', youtubeId: 'fHI8X4OXluQ' })],
    }, 60000);
    expect(emitAck).toHaveBeenCalledWith('player:play', expect.objectContaining({ positionMs: 0 }));
    expect(window.location.pathname).toBe('/room/TRACK2');
    expect(container.querySelector('h1')?.textContent).toBe('Blinding Lights');
  } finally {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  }
});
