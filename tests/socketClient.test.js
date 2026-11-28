import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createApp } from '../server/src/index.js';

it('creates and rejoins a room over polling when WebSocket is unavailable', async () => {
  const { server, io, cleanupInterval } = createApp();
  io.engine.opts.transports = ['polling'];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  vi.stubEnv('VITE_SOCKET_URL', `http://127.0.0.1:${server.address().port}`);
  const { emitAck, getSocket } = await import('../src/services/socketClient.js');

  try {
    const created = await emitAck('room:create', { name: 'Host', source: 'youtube' }, 4000);
    expect(created.ok).toBe(true);
    expect(getSocket().io.engine.transport.name).toBe('polling');

    const resumed = await emitAck('room:join', {
      roomCode: created.roomCode,
      sessionToken: created.sessionToken,
      name: 'Guest',
      source: 'youtube',
    }, 4000);
    expect(resumed.participantId).toBe(created.participantId);
    expect(resumed.role).toBe('host');
  } finally {
    getSocket().disconnect();
    vi.unstubAllEnvs();
    clearInterval(cleanupInterval);
    await io.close();
  }
});
