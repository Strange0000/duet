import { describe, it, expect } from 'vitest';
import { ClockSync } from '../src/utils/clockSync.js';
import { computeExpectedPositionMs, evaluateDriftCorrection } from '../src/utils/playbackSync.js';

describe('ClockSync & PlaybackSync', () => {
  it('computes expected position accurately for playing and paused states', () => {
    const playing = {
      playbackState: 'playing',
      anchorPositionMs: 10000,
      anchorServerTimeMs: 100000,
      effectiveAtServerMs: 100000,
      durationMs: 60000,
    };
    expect(computeExpectedPositionMs(playing, 105000)).toBe(15000);
    expect(computeExpectedPositionMs(playing, 200000)).toBe(60000); // Clamped to duration

    const paused = { ...playing, playbackState: 'paused' };
    expect(computeExpectedPositionMs(paused, 120000)).toBe(10000);

    const scheduled = {
      ...playing,
      anchorPositionMs: 0,
      anchorServerTimeMs: 102000,
      effectiveAtServerMs: 102000,
    };
    expect(computeExpectedPositionMs(scheduled, 101000)).toBe(0);
    expect(computeExpectedPositionMs(scheduled, 103000)).toBe(1000);
  });

  it('applies drift correction thresholds and cooldowns properly', () => {
    // < 150ms -> none
    expect(evaluateDriftCorrection({ expectedMs: 10000, actualMs: 10100 }).action).toBe('none');

    // 150..350ms -> tolerate
    expect(evaluateDriftCorrection({ expectedMs: 10000, actualMs: 10250 }).action).toBe('tolerate');

    // 350..1000ms -> wait on first sample, seek on second consecutive sample
    const first = evaluateDriftCorrection({
      expectedMs: 10000,
      actualMs: 10500,
      consecutiveModerateCount: 0,
      lastCorrectionAtMs: 0,
      nowMs: 10000,
    });
    expect(first.action).toBe('wait');
    expect(first.nextConsecutiveCount).toBe(1);

    const second = evaluateDriftCorrection({
      expectedMs: 10000,
      actualMs: 10500,
      consecutiveModerateCount: first.nextConsecutiveCount,
      lastCorrectionAtMs: 0,
      nowMs: 10000,
    });
    expect(second.action).toBe('seek');
    expect(second.targetMs).toBe(10000);

    // > 1000ms -> seek immediately if cooldown elapsed
    const large = evaluateDriftCorrection({
      expectedMs: 10000,
      actualMs: 12000,
      lastCorrectionAtMs: 0,
      nowMs: 10000,
    });
    expect(large.action).toBe('seek');
  });

  it('rejects high-RTT outliers and computes median clock offset', async () => {
    const cs = new ClockSync();
    let idx = 0;
    const fakeServerOffset = 500;
    const fakePing = async ({ clientSentAtMs }) => {
      idx += 1;
      if (idx === 5) {
        await new Promise((r) => setTimeout(r, 80)); // slow outlier
      }
      return {
        ok: true,
        clientSentAtMs,
        serverReceivedAtMs: clientSentAtMs + fakeServerOffset,
        serverSentAtMs: clientSentAtMs + fakeServerOffset,
      };
    };

    const metrics = await cs.sync(fakePing, 5);
    expect(metrics.sampleCount).toBe(3);
    expect(Math.abs(metrics.clockOffsetMs - fakeServerOffset)).toBeLessThan(60);
  });
});
