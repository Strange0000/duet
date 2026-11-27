import { describe, it, expect } from 'vitest';
import { ClockSync } from '../src/utils/clockSync.js';
import {
  computeExpectedPositionMs,
  computePlaybackSignature,
  evaluateDriftCorrection,
  playerHasStarted,
  shouldReapplyPlayback,
} from '../src/utils/playbackSync.js';

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

  it('never seeks the player back near its real end (N-02 / B2)', () => {
    // Stored duration is 210s, so expectedMs is clamped there, but the real
    // player duration is 274s and the player is 1s from its real end.
    const nearEnd = evaluateDriftCorrection({
      expectedMs: 210000,
      actualMs: 273000,
      lastCorrectionAtMs: 0,
      nowMs: 10000,
      playerDurationMs: 274000,
    });
    expect(nearEnd.action).toBe('none');
    expect(nearEnd.nearEnd).toBe(true);

    // More than 1500ms from the real end: the large drift still corrects.
    const notNearEnd = evaluateDriftCorrection({
      expectedMs: 210000,
      actualMs: 270000,
      lastCorrectionAtMs: 0,
      nowMs: 10000,
      playerDurationMs: 274000,
    });
    expect(notNearEnd.action).toBe('seek');
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

// ---------------------------------------------------------------- R1 follow-up:
// playback re-application dedup. The server re-broadcasts room:state
// ~every second (each player:status report triggers one), and every
// broadcast re-ran the effect that drives the player — so play()/seek()
// were re-issued every second while the room played, restarting the
// YouTube load each time (first Play stuck on "Buffering" at 00:00 for
// ~40s) and clearing the stall watchdog before it could fire.
describe('computePlaybackSignature / shouldReapplyPlayback (R1 follow-up)', () => {
  const track = { id: 'trk-1' };
  const playback = {
    trackVersion: 3,
    playbackState: 'playing',
    anchorPositionMs: 0,
    anchorServerTimeMs: 100000,
    effectiveAtServerMs: 100000,
  };
  const signature = computePlaybackSignature(track, playback);

  it('produces a stable signature for the same command', () => {
    expect(computePlaybackSignature(track, playback)).toBe(signature);
    expect(computePlaybackSignature(track, { ...playback })).toBe(signature);
  });

  it('changes the signature when the command changes', () => {
    expect(
      computePlaybackSignature(track, { ...playback, playbackState: 'paused' })
    ).not.toBe(signature);
    expect(
      computePlaybackSignature(track, { ...playback, trackVersion: 4 })
    ).not.toBe(signature);
    expect(
      computePlaybackSignature(track, { ...playback, anchorPositionMs: 5000 })
    ).not.toBe(signature);
    expect(computePlaybackSignature({ id: 'trk-2' }, playback)).not.toBe(signature);
  });

  it('returns null without a track or playback', () => {
    expect(computePlaybackSignature(null, playback)).toBeNull();
    expect(computePlaybackSignature(track, null)).toBeNull();
  });

  it('re-applies a new command, a new track, or a changed anchor', () => {
    const base = {
      signature,
      lastSignature: signature,
      trackKey: 'trk-1:3',
      lastTrackKey: 'trk-1:3',
      livePlayerState: 'buffering',
      playbackState: 'playing',
    };
    expect(shouldReapplyPlayback({ ...base, lastSignature: 'other' })).toBe(true);
    expect(shouldReapplyPlayback({ ...base, lastTrackKey: 'trk-1:2' })).toBe(true);
    expect(
      shouldReapplyPlayback({ ...base, signature: 'trk-1:4:playing:0:100000:100000' })
    ).toBe(true);
  });

  it('does NOT re-apply the same playing command while the player is playing or starting', () => {
    const base = {
      signature,
      lastSignature: signature,
      trackKey: 'trk-1:3',
      lastTrackKey: 'trk-1:3',
      playbackState: 'playing',
    };
    for (const state of ['playing', 'buffering', 'cued', 'unstarted']) {
      expect(shouldReapplyPlayback({ ...base, livePlayerState: state })).toBe(false);
    }
  });

  it('re-applies the same playing command when the player is paused (native pause)', () => {
    const base = {
      signature,
      lastSignature: signature,
      trackKey: 'trk-1:3',
      lastTrackKey: 'trk-1:3',
      playbackState: 'playing',
    };
    for (const state of ['paused', 'ready', 'idle', 'ended', null]) {
      expect(shouldReapplyPlayback({ ...base, livePlayerState: state })).toBe(true);
    }
  });

  it('does NOT re-apply the same paused command while the player is already paused/stopped', () => {
    const base = {
      signature,
      lastSignature: signature,
      trackKey: 'trk-1:3',
      lastTrackKey: 'trk-1:3',
      playbackState: 'paused',
    };
    for (const state of ['paused', 'idle', 'ended']) {
      expect(shouldReapplyPlayback({ ...base, livePlayerState: state })).toBe(false);
    }
  });

  it('re-applies the same paused command when the player is still going', () => {
    const base = {
      signature,
      lastSignature: signature,
      trackKey: 'trk-1:3',
      lastTrackKey: 'trk-1:3',
      playbackState: 'paused',
    };
    for (const state of ['playing', 'buffering', 'cued', 'ready', null]) {
      expect(shouldReapplyPlayback({ ...base, livePlayerState: state })).toBe(true);
    }
  });
});

describe('playerHasStarted (R1 follow-up drift guard)', () => {
  it('counts playing and paused as started', () => {
    expect(playerHasStarted('playing')).toBe(true);
    expect(playerHasStarted('paused')).toBe(true);
  });

  it('counts cueing/buffering/unknown states as not started', () => {
    for (const state of ['buffering', 'cued', 'unstarted', 'idle', 'ready', 'ended', null, undefined]) {
      expect(playerHasStarted(state)).toBe(false);
    }
  });
});
