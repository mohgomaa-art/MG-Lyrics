/**
 * lyricsClock.ts
 * Overlay-side playback clock + line/word resolution.
 *
 * The overlay window is a separate WebView from the player window, so it cannot
 * read the <audio> element. Instead the player sends *anchors* (position + the
 * wall-clock instant the position was read). The overlay keeps a monotonic
 * estimate from the last anchor and corrects itself when a new anchor arrives:
 *
 *   - large error / seek / pause / track change  -> hard snap (invisible: the
 *     correct line is simply drawn on the next frame)
 *   - small error                                -> the estimate is re-anchored
 *     and the leftover delta is applied as a decaying correction, so the text
 *     never visibly jumps for a few tens of milliseconds of network/event jitter
 *
 * Time base: `Date.now()` (wall clock, shared by every WebView on the machine).
 * `performance.now()` is NOT usable across windows - each document has its own
 * time origin - which is why anchors carry wall time and the overlay measures
 * latency from it.
 *
 * This module is pure (no Tauri, no React) so it can be unit-tested in Node.
 */

export interface LyricLine {
  time: number;
  text: string;
  /** true for estimated (non-synced) lines produced by the backend: show fully lit */
  est?: boolean;
}

export interface SyncAnchor {
  /** Track the anchor belongs to. A change forces a hard reset. */
  trackId: string;
  /** audio.currentTime in seconds at the instant the player read it. */
  position: number;
  /** Date.now() in the player window at that same instant. */
  wall: number;
  playing: boolean;
  /** audio.playbackRate (1 when unknown). */
  rate: number;
  /** Track duration in seconds when known (0 otherwise). */
  duration?: number;
}

export type SyncResult = "snap" | "converge" | "ignore";

/** Error above which the estimate is snapped instead of slewed. */
export const SNAP_THRESHOLD = 0.3;
/** Time constant (seconds) of the decaying correction applied after a re-anchor. */
export const CONVERGE_TAU = 0.45;

export class LyricsClock {
  private trackId = "";
  private anchorPos = 0;
  private anchorWall = 0;
  private playing = false;
  private rate = 1;
  private duration = 0;
  private correction = 0;
  private lastWall = 0;
  private synced = false;
  /** Number of hard snaps since the last reset (diagnostics). */
  snaps = 0;

  reset(trackId = ""): void {
    this.trackId = trackId;
    this.anchorPos = 0;
    this.anchorWall = 0;
    this.playing = false;
    this.rate = 1;
    this.duration = 0;
    this.correction = 0;
    this.lastWall = 0;
    this.synced = false;
    this.snaps = 0;
  }

  /** True once at least one anchor has been applied. */
  isSynced(): boolean {
    return this.synced;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Uncorrected extrapolation from the current anchor. */
  private rawAt(wall: number): number {
    if (!this.synced) return 0;
    if (!this.playing) return this.anchorPos;
    return this.anchorPos + ((wall - this.anchorWall) / 1000) * this.rate;
  }

  private clamp(pos: number): number {
    if (!isFinite(pos) || pos < 0) return 0;
    if (this.duration > 0 && pos > this.duration) return this.duration;
    return pos;
  }

  /**
   * Apply a fresh anchor.
   * @param wallNow the overlay's Date.now() at the moment the anchor arrived.
   */
  sync(anchor: SyncAnchor, wallNow: number): SyncResult {
    const pos = Number.isFinite(anchor.position) ? Math.max(0, anchor.position) : 0;
    const rate = Number.isFinite(anchor.rate) && anchor.rate > 0 ? anchor.rate : 1;
    const duration = Number.isFinite(anchor.duration) && (anchor.duration ?? 0) > 0 ? (anchor.duration as number) : 0;

    // New track (or first anchor): nothing to preserve.
    if (!this.synced || anchor.trackId !== this.trackId) {
      this.trackId = anchor.trackId;
      this.anchorPos = pos;
      this.anchorWall = anchor.wall;
      this.playing = anchor.playing;
      this.rate = rate;
      this.duration = duration;
      this.correction = 0;
      this.lastWall = wallNow;
      this.synced = true;
      this.snaps = 0;
      return "snap";
    }

    // Stale / out-of-order anchor (a heartbeat overtaken by a seek, or a
    // delayed IPC message): keep the current estimate rather than dragging the
    // clock backwards.
    if (!Number.isFinite(anchor.wall) || anchor.wall < this.anchorWall) {
      return "ignore";
    }

    const predicted = this.rawAt(wallNow);
    // What the display would show after adopting the anchor: the anchor already
    // accounts for transport latency because it is extrapolated from `wall`.
    const fresh = pos + ((wallNow - anchor.wall) / 1000) * rate;
    const err = fresh - predicted;

    this.duration = duration || this.duration;
    this.rate = rate;

    // Paused, pause/play transition, or a real seek: authoritative, no smoothing.
    if (!anchor.playing || anchor.playing !== this.playing || Math.abs(err) > SNAP_THRESHOLD) {
      this.anchorPos = pos;
      this.anchorWall = anchor.wall;
      this.playing = anchor.playing;
      this.correction = 0;
      this.lastWall = wallNow;
      this.snaps += 1;
      return "snap";
    }

    // Small error: re-anchor on the new value and fold the delta into a
    // correction that decays, so the display keeps moving without a jump.
    this.correction = predicted - fresh;
    this.anchorPos = pos;
    this.anchorWall = anchor.wall;
    this.playing = true;
    this.lastWall = wallNow;
    return "converge";
  }

  /** Estimated audio position (seconds) at the given wall-clock instant. */
  positionAt(wall: number): number {
    if (!this.synced) return 0;
    const dt = Math.max(0, (wall - this.lastWall) / 1000);
    this.lastWall = wall;
    if (this.correction !== 0) {
      this.correction *= Math.exp(-dt / CONVERGE_TAU);
      if (Math.abs(this.correction) < 0.002) this.correction = 0;
    }
    return this.clamp(this.rawAt(wall) + this.correction);
  }
}

/** Index of the last line whose time is <= t, or -1 before the first line. */
export function selectLineIndex(lines: LyricLine[] | null | undefined, t: number): number {
  if (!lines || lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t + 1e-3) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface WordState {
  /** Index of the highlighted word, -1 when the line has no words. */
  activeWord: number;
  /** Seconds elapsed since the line started. */
  elapsed: number;
  /** Effective highlight duration for the line (seconds). */
  lineDuration: number;
  /** True once every word has been highlighted. */
  finished: boolean;
  words: string[];
}

/**
 * Word-by-word highlight state. The pacing formula is unchanged from the
 * original overlay so the visual result is identical; only the input position
 * is now accurate.
 */
export function wordState(
  lines: LyricLine[] | null | undefined,
  idx: number,
  t: number
): WordState {
  if (!lines || idx < 0 || idx >= lines.length) {
    return { activeWord: -1, elapsed: 0, lineDuration: 4.5, finished: false, words: [] };
  }
  const current = lines[idx];
  const nextLine = idx + 1 < lines.length ? lines[idx + 1] : null;
  const words = current.text.split(" ").filter(Boolean);
  const natural = nextLine ? nextLine.time - current.time : 4.5;
  const capped = Math.min(natural, Math.max(2.5, words.length * 0.6));
  const elapsed = Math.max(0, t - current.time);
  const wDur = words.length > 0 ? capped / words.length : 1;
  const activeWord =
    words.length === 0
      ? -1
      : current.est || elapsed >= capped
        ? words.length
        : Math.min(Math.floor(elapsed / wDur), words.length - 1);
  return {
    activeWord,
    elapsed,
    lineDuration: capped,
    finished: words.length > 0 && elapsed >= capped,
    words,
  };
}
