const NUMBER = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/;
export function parsePath(d) {
  const out = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const number = () => {
    skip();
    const m = d.slice(i).match(NUMBER);
    if (!m) throw new Error(`Bad path near "${d.slice(i, i + 12)}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const flag = () => {
    skip();
    const f = d[i++];
    if (f !== "0" && f !== "1") throw new Error(`Bad arc flag in "${d}"`);
    return f === "1";
  };
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let cmd = null;
  while (true) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) throw new Error(`Bad path "${d}"`);
    const lower = cmd.toLowerCase();
    if (lower === "z") {
      out.push([cmd]);
      continue;
    }
    const args =
      lower === "a"
        ? [number(), number(), number(), flag(), flag(), number(), number()]
        : Array.from({ length: ARGS[lower] }, number);
    out.push([cmd, ...args]);
    // Extra pairs after a move are lines.
    if (cmd === "m") cmd = "l";
    if (cmd === "M") cmd = "L";
  }
  return out;
}
