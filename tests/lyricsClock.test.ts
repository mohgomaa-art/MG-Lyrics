/**
 * lyricsClock.test.ts
 * Run with: node --experimental-strip-types src/utils/lyricsClock.test.ts
 * (pure Node, no extra dependencies)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LyricsClock,
  selectLineIndex,
  wordState,
  SNAP_THRESHOLD,
  type LyricLine,
} from "../src/utils/lyricsClock.ts";

const LINES: LyricLine[] = [
  { time: 0.0, text: "first line of the song" },
  { time: 3.2, text: "second line here" },
  { time: 7.05, text: "third line" },
  { time: 11.5, text: "fourth line is longer than the rest" },
];

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("tracks playback with 330ms jittered anchors and 20-60ms latency (5 minutes)", () => {
  const rand = rng(7);
  const clock = new LyricsClock();
  let worst = 0;
  let worstAt = 0;
  const truthAt = (t: number) => t; // audio position == elapsed wall time

  for (let T = 0; T <= 300; T += 0.33 + rand() * 0.08) {
    const latencyMs = 20 + rand() * 40;
    const arriveAt = T + latencyMs / 1000;
    clock.sync(
      { trackId: "a", position: truthAt(T), wall: T * 1000, playing: true, rate: 1, duration: 1000 },
      arriveAt * 1000
    );
    // sample the estimate every 20ms until the next anchor
    for (let k = 0; k < 16; k++) {
      const t = arriveAt + k * 0.02;
      const err = Math.abs(clock.positionAt(t * 1000) - truthAt(t));
      if (err > worst) {
        worst = err;
        worstAt = t;
      }
    }
  }
  assert.ok(worst < 0.05, `max error ${(worst * 1000).toFixed(1)}ms at ${worstAt.toFixed(2)}s`);
});

test("stays accurate when the player window is throttled to 1 anchor per second", () => {
  const clock = new LyricsClock();
  let worst = 0;
  for (let T = 0; T <= 120; T += 1) {
    const arriveAt = T + 0.03;
    clock.sync({ trackId: "a", position: T, wall: T * 1000, playing: true, rate: 1, duration: 1000 }, arriveAt * 1000);
    for (let k = 0; k < 50; k++) {
      const t = arriveAt + k * 0.02;
      worst = Math.max(worst, Math.abs(clock.positionAt(t * 1000) - t));
    }
  }
  assert.ok(worst < 0.05, `max error ${(worst * 1000).toFixed(1)}ms`);
});

test("a paused player freezes the clock and does not drift", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 42.5, wall: 0, playing: true, rate: 1, duration: 200 }, 0);
  assert.ok(Math.abs(clock.positionAt(1000) - 43.5) < 0.01);
  clock.sync({ trackId: "a", position: 43.5, wall: 1000, playing: false, rate: 1, duration: 200 }, 1050);
  assert.equal(clock.positionAt(60_000), 43.5);
  assert.equal(clock.positionAt(600_000), 43.5);
});

test("resuming after a pause restarts from the right place", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 10, wall: 0, playing: true, rate: 1 }, 0);
  clock.sync({ trackId: "a", position: 20, wall: 10_000, playing: false, rate: 1 }, 10_050);
  assert.equal(clock.positionAt(70_000), 20);
  clock.sync({ trackId: "a", position: 20, wall: 70_000, playing: true, rate: 1 }, 70_030);
  assert.ok(Math.abs(clock.positionAt(72_000) - 22) < 0.01);
});

test("a seek snaps on the next frame instead of sliding", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 5, wall: 0, playing: true, rate: 1 }, 0);
  assert.ok(Math.abs(clock.positionAt(1000) - 6) < 0.01);
  const res = clock.sync({ trackId: "a", position: 95.4, wall: 1000, playing: true, rate: 1 }, 1030);
  assert.equal(res, "snap");
  assert.ok(Math.abs(clock.positionAt(1030) - 95.43) < 0.01, "position must land on the seek target immediately (plus the 30ms elapsed since the read)");
  assert.equal(clock.snaps, 1);
});

test("a small correction converges without a visible jump", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 30, wall: 0, playing: true, rate: 1 }, 0);
  const before = clock.positionAt(2000); // 32.0
  const res = clock.sync({ trackId: "a", position: 31.9, wall: 2000, playing: true, rate: 1 }, 2030);
  assert.equal(res, "converge");
  const after = clock.positionAt(2030);
  // 30ms of real time passed between the two samples; anything beyond that is a jump
  assert.ok(Math.abs(after - (before + 0.03)) < 0.005, `jump of ${((after - before - 0.03) * 1000).toFixed(1)}ms`);
  // and it converges to the anchor within ~1.5s
  const settled = clock.positionAt(2030 + 1500);
  assert.ok(Math.abs(settled - (31.9 + 1.53)) < 0.01, `settled at ${settled}`);
});

test("a delayed older anchor is ignored", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 50, wall: 10_000, playing: true, rate: 1 }, 10_010);
  const res = clock.sync({ trackId: "a", position: 40, wall: 8_000, playing: true, rate: 1 }, 10_020);
  assert.equal(res, "ignore");
  assert.ok(clock.positionAt(10_020) > 50, "clock must not move backwards");
});

test("track change resets the clock", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 180, wall: 0, playing: true, rate: 1 }, 0);
  assert.equal(clock.sync({ trackId: "b", position: 0, wall: 500, playing: true, rate: 1 }, 520), "snap");
  assert.ok(clock.positionAt(520) < 0.1);
  assert.equal(clock.snaps, 0, "a fresh track starts with a clean snap counter");
});

test("playbackRate other than 1 is honoured", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 0, wall: 0, playing: true, rate: 1.5 }, 0);
  assert.ok(Math.abs(clock.positionAt(2000) - 3) < 0.01);
});

test("audio clock drift (0.2% faster than wall clock) stays under 50ms", () => {
  const clock = new LyricsClock();
  let worst = 0;
  for (let T = 0; T <= 240; T += 2) {
    const truth = T * 1.002;
    clock.sync({ trackId: "a", position: truth, wall: T * 1000, playing: true, rate: 1, duration: 1000 }, T * 1000 + 25);
    for (let k = 0; k < 90; k++) {
      const t = T + 0.025 + k * 0.02;
      worst = Math.max(worst, Math.abs(clock.positionAt(t * 1000) - t * 1.002));
    }
  }
  assert.ok(worst < 0.05, `max error ${(worst * 1000).toFixed(1)}ms`);
});

test("position is clamped to the track duration and never negative", () => {
  const clock = new LyricsClock();
  clock.sync({ trackId: "a", position: 199, wall: 0, playing: true, rate: 1, duration: 200 }, 0);
  assert.equal(clock.positionAt(10_000), 200);
  const c2 = new LyricsClock();
  c2.sync({ trackId: "b", position: -5, wall: 0, playing: true, rate: 1 }, 0);
  assert.equal(c2.positionAt(0), 0);
});

test("snap threshold boundary: 299ms converges, 301ms snaps", () => {
  assert.ok(SNAP_THRESHOLD === 0.3);
  const mk = () => {
    const c = new LyricsClock();
    c.sync({ trackId: "a", position: 10, wall: 0, playing: true, rate: 1 }, 0);
    return c;
  };
  assert.equal(mk().sync({ trackId: "a", position: 10 + 0.299, wall: 0, playing: true, rate: 1 }, 5), "converge");
  assert.equal(mk().sync({ trackId: "a", position: 10 + 0.301, wall: 0, playing: true, rate: 1 }, 5), "snap");
});

test("selectLineIndex picks the right line, including before the first line", () => {
  assert.equal(selectLineIndex(LINES, -1), -1);
  assert.equal(selectLineIndex(LINES, 0), 0);
  assert.equal(selectLineIndex(LINES, 3.19), 0);
  assert.equal(selectLineIndex(LINES, 3.2), 1);
  assert.equal(selectLineIndex(LINES, 7.04), 1);
  assert.equal(selectLineIndex(LINES, 7.05), 2);
  assert.equal(selectLineIndex(LINES, 999), 3);
  assert.equal(selectLineIndex(null, 5), -1);
  assert.equal(selectLineIndex([], 5), -1);
});

test("wordState walks the words of a line and then reports finished", () => {
  const s0 = wordState(LINES, 1, 3.2); // "second line here", 3.85s until next line
  assert.deepEqual(s0.words, ["second", "line", "here"]);
  assert.equal(s0.activeWord, 0);
  // 3.85s to the next line, but the per-word cap (3 words * 0.6s, min 2.5s) wins
  assert.ok(Math.abs(s0.lineDuration - 2.5) < 1e-9, `lineDuration ${s0.lineDuration}`);

  const sMid = wordState(LINES, 1, 3.2 + s0.lineDuration / 2);
  assert.equal(sMid.activeWord, 1);

  const sEnd = wordState(LINES, 1, 3.2 + s0.lineDuration + 0.01);
  assert.equal(sEnd.finished, true);
  assert.equal(sEnd.activeWord, 3, "finished lines highlight every word (activeWord == words.length)");

  const empty = wordState(LINES, -1, 1);
  assert.equal(empty.activeWord, -1);
  assert.deepEqual(empty.words, []);
});
