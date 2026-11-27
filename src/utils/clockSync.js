/**
 * Clock synchronization helper using monotonic performance.now() for RTT measurement
 * and median-of-low-latency-samples offset estimation.
 */
export class ClockSync {
  constructor() {
    this.samples = [];
    this.clockOffsetMs = 0; // estimatedServerNow = Date.now() + clockOffsetMs
    this.rttMs = 0;
    this.lastSyncedAtMs = null;
  }

  /**
   * Run N ping-pong samples over a Socket.IO client and compute median offset.
   */
  async sync(emitPing, sampleCount = 5) {
    const collected = [];

    for (let i = 0; i < sampleCount; i++) {
      const monoStart = performance.now();
      const wallStart = Date.now();
      try {
        const pong = await emitPing({ clientSentAtMs: wallStart, seq: i });
        const monoEnd = performance.now();
        if (!pong || !pong.ok) continue;

        const rtt = Math.max(0, monoEnd - monoStart);
        const serverMid = (pong.serverReceivedAtMs + pong.serverSentAtMs) / 2;
        const clientMid = wallStart + rtt / 2;
        const offset = serverMid - clientMid;

        collected.push({ rtt, offset });
      } catch {
        // Ignore single failed sample
      }
      if (i < sampleCount - 1) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    if (collected.length === 0) return this.getMetrics();

    // Sort by RTT and reject slow outliers (keep fastest 60%, minimum 1)
    collected.sort((a, b) => a.rtt - b.rtt);
    const keepCount = Math.max(1, Math.ceil(collected.length * 0.6));
    const lowLatency = collected.slice(0, keepCount);

    // Median offset & median RTT of kept samples
    const offsets = lowLatency.map((s) => s.offset).sort((a, b) => a - b);
    const rtts = lowLatency.map((s) => s.rtt).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);

    this.clockOffsetMs = Math.round(offsets[mid]);
    this.rttMs = Math.round(rtts[mid]);
    this.samples = lowLatency;
    this.lastSyncedAtMs = Date.now();

    return this.getMetrics();
  }

  estimateServerNowMs() {
    return Date.now() + this.clockOffsetMs;
  }

  getMetrics() {
    return {
      clockOffsetMs: this.clockOffsetMs,
      rttMs: this.rttMs,
      sampleCount: this.samples.length,
      lastSyncedAtMs: this.lastSyncedAtMs,
    };
  }
}
