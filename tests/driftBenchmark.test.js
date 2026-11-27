import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioc } from 'socket.io-client';
import { createApp } from '../server/src/index.js';
import { ClockSync } from '../src/utils/clockSync.js';
import { computeExpectedPositionMs, evaluateDriftCorrection } from '../src/utils/playbackSync.js';

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe('Two-Client Extended Drift & Network Benchmark', () => {
  let server;
  let cleanupInterval;
  let url;

  beforeAll(async () => {
    const created = createApp();
    server = created.server;
    cleanupInterval = created.cleanupInterval;
    await new Promise((resolve) => {
      server.listen(0, () => {
        url = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    clearInterval(cleanupInterval);
    await new Promise((resolve) => server.close(resolve));
  });

  it('maintains sub-350ms median and p95 estimated drift across play, seek, and skip', async () => {
    const host = ioc(url, { transports: ['websocket'] });
    const guest = ioc(url, { transports: ['websocket'] });

    await Promise.all([
      new Promise((r) => host.on('connect', r)),
      new Promise((r) => guest.on('connect', r)),
    ]);

    try {
      const created = await emitAck(host, 'room:create', {
        name: 'Host',
        source: 'local',
        initialTracks: [
          { id: 't1', title: 'Track 1', artist: 'Duet', durationSec: 120, localFixtureId: 't1' },
          { id: 't2', title: 'Track 2', artist: 'Duet', durationSec: 120, localFixtureId: 't2' },
        ],
      });
      await emitAck(guest, 'room:join', {
        roomCode: created.roomCode,
        name: 'Guest',
        source: 'local',
      });

      const hostClock = new ClockSync();
      const guestClock = new ClockSync();
      await hostClock.sync((p) => emitAck(host, 'sync:ping', p), 5);
      await guestClock.sync((p) => emitAck(guest, 'sync:ping', p), 5);

      let guestPlayback = null;
      guest.on('playback:state', (pb) => {
        guestPlayback = pb;
      });
      guest.on('playback:scheduled', (pb) => {
        guestPlayback = pb;
      });

      await emitAck(host, 'player:play', { positionMs: 5000, scheduleLeadMs: 150 });
      await new Promise((r) => setTimeout(r, 250));
      expect(guestPlayback).not.toBeNull();

      // Simulate 15 measurement ticks across play + seek + skip
      const driftSamples = [];
      let guestSimulatedPos = computeExpectedPositionMs(
        guestPlayback,
        guestClock.estimateServerNowMs()
      );
      let lastTickMono = performance.now();

      for (let step = 0; step < 15; step++) {
        await new Promise((r) => setTimeout(r, 100));
        const nowMono = performance.now();
        guestSimulatedPos += nowMono - lastTickMono;
        lastTickMono = nowMono;

        if (step === 5) {
          await emitAck(host, 'player:seek', { positionMs: 42000 });
          await new Promise((r) => setTimeout(r, 40));
          guestSimulatedPos = computeExpectedPositionMs(
            guestPlayback,
            guestClock.estimateServerNowMs()
          );
          lastTickMono = performance.now();
        }
        if (step === 10) {
          await emitAck(host, 'player:next', {});
          await new Promise((r) => setTimeout(r, 40));
          guestSimulatedPos = computeExpectedPositionMs(
            guestPlayback,
            guestClock.estimateServerNowMs()
          );
          lastTickMono = performance.now();
        }

        const expected = computeExpectedPositionMs(
          guestPlayback,
          guestClock.estimateServerNowMs()
        );
        const evalRes = evaluateDriftCorrection({
          expectedMs: expected,
          actualMs: guestSimulatedPos,
        });
        driftSamples.push(evalRes.absDriftMs);
      }

      driftSamples.sort((a, b) => a - b);
      const medianDrift = percentile(driftSamples, 50);
      const p95Drift = percentile(driftSamples, 95);

      expect(medianDrift).toBeLessThan(150);
      expect(p95Drift).toBeLessThan(350);
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });
});
