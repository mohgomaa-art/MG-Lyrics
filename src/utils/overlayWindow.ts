/**
 * overlayWindow.ts
 * Create / restore / tear down the floating lyrics overlay window.
 *
 * Two things this module gets right that the inline version did not:
 *
 * 1. DPI units. `WebviewWindow` `x`/`y` options are **logical** pixels
 *    (@tauri-apps/api/window.d.ts, WindowOptions.x/y), while
 *    `outerPosition()` returns a **PhysicalPosition** (window.d.ts:317).
 *    Persisting one and restoring the other scales the saved position by the
 *    display scale factor on every launch, so on a 125/150% display the overlay
 *    walks off its place (or off the screen) after a few restarts.
 *
 * 2. Monitor changes. A saved position can point at a monitor that is gone
 *    (laptop undocked, projector unplugged). The overlay is click-through,
 *    always-on-top and hidden from the taskbar, so a window restored off-screen
 *    is invisible and cannot be dragged back. Saved positions are validated
 *    against the live work areas and re-centred when they no longer fit.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, type Monitor } from "@tauri-apps/api/window";
import { isTauriApp } from "./tauriBridge";

export const OVERLAY_LABEL = "lyrics";
export const OVERLAY_POS_KEY = "mg_lyrics_pos";
export const OVERLAY_WIDTH = 920;
export const OVERLAY_HEIGHT = 150;
const OVERLAY_MIN_WIDTH = 360;
const OVERLAY_MIN_HEIGHT = 90;
/** Margin kept from the bottom of the work area when the overlay is re-centred. */
const BOTTOM_MARGIN = 80;

export interface OverlayRect {
  /** Logical pixels. */
  x: number;
  y: number;
  /** Display scale factor the rect was captured at (0 when unknown). */
  scale: number;
}

interface LogicalWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readSavedRect(): OverlayRect | null {
  try {
    const raw = localStorage.getItem(OVERLAY_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return null;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return {
      x: parsed.x,
      y: parsed.y,
      scale: typeof parsed.scale === "number" && parsed.scale > 0 ? parsed.scale : 0,
    };
  } catch {
    return null;
  }
}

export function saveOverlayRect(x: number, y: number, scale: number): void {
  try {
    localStorage.setItem(
      OVERLAY_POS_KEY,
      JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        scale: scale > 0 ? scale : 0,
      })
    );
  } catch {
    /* storage full / disabled - position just will not persist */
  }
}

function toLogicalWorkAreas(monitors: Monitor[]): LogicalWorkArea[] {
  return monitors.map((m) => {
    const scale = m.scaleFactor > 0 ? m.scaleFactor : 1;
    return {
      x: m.workArea.position.x / scale,
      y: m.workArea.position.y / scale,
      width: m.workArea.size.width / scale,
      height: m.workArea.size.height / scale,
    };
  });
}

/** How much of the overlay rect (0..1) sits inside one of the given work areas. */
function visibleFraction(rect: OverlayRect, areas: LogicalWorkArea[]): number {
  const w = OVERLAY_WIDTH;
  const h = OVERLAY_HEIGHT;
  let best = 0;
  for (const a of areas) {
    const overlapW = Math.min(rect.x + w, a.x + a.width) - Math.max(rect.x, a.x);
    const overlapH = Math.min(rect.y + h, a.y + a.height) - Math.max(rect.y, a.y);
    if (overlapW <= 0 || overlapH <= 0) continue;
    best = Math.max(best, (overlapW * overlapH) / (w * h));
  }
  return best;
}

/** Bottom-centre of the primary work area, above the taskbar. */
function defaultRect(areas: LogicalWorkArea[]): OverlayRect {
  const primary = areas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const x = primary.x + Math.max(0, (primary.width - OVERLAY_WIDTH) / 2);
  const y = primary.y + Math.max(0, primary.height - OVERLAY_HEIGHT - BOTTOM_MARGIN);
  return { x: Math.round(x), y: Math.round(y), scale: 0 };
}

/**
 * Resolve the position the overlay should open at: the saved one when at least
 * 60% of it is still on a connected display, otherwise bottom-centre of the
 * primary display. Also pulls a saved rect fully back into its work area.
 */
export async function resolveOverlayRect(): Promise<OverlayRect> {
  const saved = readSavedRect();
  if (!isTauriApp()) return saved ?? { x: 0, y: 0, scale: 0 };

  let areas: LogicalWorkArea[] = [];
  try {
    areas = toLogicalWorkAreas(await availableMonitors());
  } catch {
    /* permission missing / platform without monitors: fall back to the saved rect */
  }
  if (areas.length === 0) return saved ?? { x: 0, y: 0, scale: 0 };

  if (!saved) return defaultRect(areas);
  if (visibleFraction(saved, areas) < 0.6) return defaultRect(areas);

  // Clamp a mostly-visible rect so its title/first line is not cut off.
  const area = areas.find((a) => {
    const overlapW = Math.min(saved.x + OVERLAY_WIDTH, a.x + a.width) - Math.max(saved.x, a.x);
    const overlapH = Math.min(saved.y + OVERLAY_HEIGHT, a.y + a.height) - Math.max(saved.y, a.y);
    return overlapW > 0 && overlapH > 0;
  });
  if (!area) return defaultRect(areas);

  const maxX = area.x + area.width - OVERLAY_WIDTH;
  const maxY = area.y + area.height - OVERLAY_HEIGHT;
  return {
    x: Math.round(Math.min(Math.max(saved.x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(saved.y, area.y), Math.max(area.y, maxY))),
    scale: saved.scale,
  };
}

/** Wait until the webview actually exists (or creation failed). */
function waitForCreated(win: WebviewWindow, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    win
      .once("tauri://created", () => {
        clearTimeout(timer);
        done(true);
      })
      .catch(() => {});
    win
      .once("tauri://error", () => {
        clearTimeout(timer);
        done(false);
      })
      .catch(() => {});
  });
}

/**
 * Show the overlay, creating it if needed. Returns the window, or null when the
 * platform cannot create it (browser preview, creation error).
 */
export async function openOverlayWindow(): Promise<WebviewWindow | null> {
  if (!isTauriApp()) return null;

  const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  if (existing) {
    try {
      await existing.show();
    } catch {
      /* already visible */
    }
    return existing;
  }

  const rect = await resolveOverlayRect();
  let win: WebviewWindow;
  try {
    win = new WebviewWindow(OVERLAY_LABEL, {
      url: "index.html#lyrics",
      title: "",
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      minWidth: OVERLAY_MIN_WIDTH,
      minHeight: OVERLAY_MIN_HEIGHT,
      x: rect.x,
      y: rect.y,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      focus: false, // never steal focus from a game
      visible: false, // shown by the overlay itself once it has painted
      preventOverflow: true, // belt and braces on top of resolveOverlayRect()
    });
  } catch (err) {
    console.warn("[overlay] create failed:", err);
    return null;
  }

  const created = await waitForCreated(win);
  if (!created) {
    // The event can be missed if the webview is created before the listener is
    // attached; trust the window manager over the event.
    const exists = await WebviewWindow.getByLabel(OVERLAY_LABEL).catch(() => null);
    if (!exists) {
      console.warn("[overlay] window was not created (label clash or platform error)");
      return null;
    }
  }
  saveOverlayRect(rect.x, rect.y, rect.scale);
  // The overlay shows itself after its first paint, but that needs its own ACL
  // permission. Do not depend on it: the main window (which is allowed to) shows
  // it after a short delay if it is still hidden, so it can never stay invisible.
  setTimeout(() => {
    win.isVisible().then((v) => { if (!v) return win.show(); }).catch(() => {
      win.show().catch((e) => console.warn("[overlay] show failed:", e));
    });
  }, 1200);
  return win;
}

/** Close and destroy the overlay window. Safe to call when it does not exist. */
export async function closeOverlayWindow(): Promise<void> {
  if (!isTauriApp()) return;
  const win = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  if (!win) return;
  try {
    await win.close();
  } catch {
    try {
      await win.destroy();
    } catch {
      /* already gone */
    }
  }
}
