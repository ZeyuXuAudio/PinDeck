/* Line diff (LCS) with unified-style hunks, good enough for slide-sized files. */

export function diffLines(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  // trim common prefix/suffix so the LCS table stays small
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const n = a2.length, m = b2.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([" ", A[k], k + 1, k + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { ops.push([" ", a2[i], pre + i + 1, pre + j + 1]); i++; j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) { ops.push(["-", a2[i], pre + i + 1, null]); i++; }
    else { ops.push(["+", b2[j], null, pre + j + 1]); j++; }
  }
  for (let k = 0; k < suf; k++) ops.push([" ", A[A.length - suf + k], A.length - suf + k + 1, B.length - suf + k + 1]);
  return ops;
}

export function unifiedDiff(a, b, file, context = 2) {
  const ops = diffLines(a, b);
  let added = 0, removed = 0;
  const changed = ops.map((o, k) => (o[0] !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return { text: "", added, removed };
  const keep = new Set();
  for (const k of changed) for (let d = -context; d <= context; d++) keep.add(k + d);
  const lines = [`--- ${file}`, `+++ ${file}`];
  let last = -2;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1) lines.push(`@@ line ${o[2] ?? o[3]} @@`);
    lines.push(o[0] + o[1]);
    if (o[0] === "+") added++;
    if (o[0] === "-") removed++;
    last = k;
  });
  return { text: lines.join("\n"), added, removed };
}
