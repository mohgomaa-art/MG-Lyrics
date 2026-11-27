#!/usr/bin/perl -pi
# One-shot migration of hardcoded neon/purple/gradient styling to CSS design tokens (see src/index.css).
s/background:\s*"#8A2BE2",\s*color:\s*"#(?:fff|FFF|FFFFFF)"/background: "var(--accent)", color: "var(--accent-fg)"/g;
s/background:\s*"#EC4899",\s*\n?(\s*)border: "none", color: "#fff"/background: "var(--accent)",\n$1border: "none", color: "var(--accent-fg)"/g;
s/linear-gradient\((?:90|135|180)deg,\s*[^")]*(?:\([^)]*\)[^")]*)*\)/var(--surface-2)/g;
s/#8A2BE2/var(--accent)/gi;
s/rgba\(138,\s*43,\s*226,\s*([0-9.]+)\)/color-mix(in srgb, var(--accent) @{[$1*100]}%, transparent)/g;
s/rgba\(255,\s*255,\s*255,\s*([0-9.]+)\)/color-mix(in srgb, var(--text) @{[$1*100]}%, transparent)/g;
s/#9FA2B4/var(--text-2)/gi;
s/#5A5D70/var(--text-3)/gi;
s/#(?:0C0C12|10101a|08080C)\b/var(--bg)/gi;
s/(color:\s*)"#(?:fff|FFF|FFFFFF)"/$1"var(--text)"/g;
s/text-white\b/text-[var(--text)]/g;
