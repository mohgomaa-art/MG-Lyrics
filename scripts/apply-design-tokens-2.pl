#!/usr/bin/perl -pi
s/rgba\(0,\s*240,\s*255,\s*([0-9.]+)\)/color-mix(in srgb, var(--accent) @{[$1*100]}%, transparent)/g;
s/rgba\(236,\s*72,\s*153,\s*([0-9.]+)\)/color-mix(in srgb, var(--accent) @{[$1*100]}%, transparent)/g;
s/rgba\(29,\s*185,\s*84,\s*0?\.(?:3|35)\)/color-mix(in srgb, var(--accent) 30%, transparent)/g;
s/#(?:00F0FF|EC4899|6366f1|FF007F|7c3aed|db2777|8b5cf6|06b6d4)\b(?!,)/var(--accent)/gi;
s/"radial-gradient\(circle at 50% 50%, #1a1a2e 60%, #0d0d1a 100%\)"/"var(--surface-2)"/;
s/#0d0d1a\b/var(--surface)/g;
