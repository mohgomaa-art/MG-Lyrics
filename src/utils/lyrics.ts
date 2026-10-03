export interface LyricLine {
  time: number;
  text: string;
}

/**
 * Parses LRC (.lrc) timed lyrics content into LyricLine array
 */
export function parseLrc(lrcText: string): LyricLine[] {
  const lines = lrcText.split("\n");
  const result: LyricLine[] = [];
  const timeRegex = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;

    const matches = Array.from(cleanLine.matchAll(timeRegex));
    if (matches.length === 0) continue;

    const text = cleanLine.replace(timeRegex, "").trim();

    for (const match of matches) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const totalSeconds = minutes * 60 + seconds;
      result.push({ time: totalSeconds, text });
    }
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

/**
 * Parses plain text lyrics into LyricLine array by spacing them out evenly
 */
export function parsePlainLyrics(plainText: string, durationSec: number = 180): LyricLine[] {
  const lines = plainText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const step = durationSec / lines.length;
  return lines.map((text, idx) => ({
    time: idx * step,
    text,
  }));
}
