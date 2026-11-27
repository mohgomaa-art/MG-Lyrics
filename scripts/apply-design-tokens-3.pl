#!/usr/bin/perl -pi
s/rgba\((?:20,\s*20,\s*32|13,\s*13,\s*20|10,\s*10,\s*16|16,\s*16,\s*26),\s*([0-9.]+)\)/color-mix(in srgb, var(--surface) @{[$1<0.9?90:100]}%, transparent)/g;
