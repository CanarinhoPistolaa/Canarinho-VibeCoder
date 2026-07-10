#!/usr/bin/env node
import { createInterface } from "node:readline";

async function main() {
  const rl = createInterface({ input: process.stdin });
  const stack = [];
  const files = [];

  for await (const rawLine of rl) {
    const line = rawLine.trimEnd();
    const m = line.match(/^ℹ(\s+)(\S.*?)\s{2,}\|\s*([\d.]+)\s*\|/);
    if (!m) continue;

    const spaces = m[1];
    const name = m[2].trim();
    const pct = parseFloat(m[3]);
    if (isNaN(pct)) continue;

    const depth = Math.floor(spaces.length / 2);
    while (stack.length > depth) stack.pop();
    stack[depth] = name;

    const fullPath = stack.slice(0, depth + 1).join("/");
    if (fullPath.startsWith("dist/")) {
      files.push({ path: fullPath, pct });
    }
  }

  if (files.length === 0) {
    console.log("0");
    return;
  }

  const sum = files.reduce((s, f) => s + f.pct, 0);
  console.log((sum / files.length / 100).toFixed(6));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
