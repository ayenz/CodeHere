/** Counts events per key in fixed time windows, e.g. login attempts per IP per minute. */
export class WindowCounter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one event and returns false if the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    let entry = this.counts.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs }
      this.counts.set(key, entry)
    }
    entry.count++
    return entry.count <= this.limit
  }

  /** Drops expired windows so the map does not grow without bound. */
  prune(now = Date.now()): void {
    for (const [key, entry] of this.counts) {
      if (entry.resetAt <= now) this.counts.delete(key)
    }
  }
}

/** Token bucket for per-connection message rates: steady rate with a bounded burst. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst
    this.last = now
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
