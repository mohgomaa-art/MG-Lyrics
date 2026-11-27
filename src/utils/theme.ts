export type ThemeMode = "dark" | "light";
const KEY = "mg_theme";

export function getTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "dark";
}

export function applyTheme(mode: ThemeMode, animate = false): void {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-switching");
    window.setTimeout(() => root.classList.remove("theme-switching"), 350);
  }
  root.setAttribute("data-theme", mode);
  try { localStorage.setItem(KEY, mode); } catch {}
}
