/* Text formats shared by the chat prompt and the CLI. */

const pad = (s, n) => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function formatLayout(L) {
  const s = L.slide;
  const lines = [];
  lines.push(`Slide ${s.index + 1} · ${s.eid} · ${s.kind} · "${s.title}"` + (s.hidden ? " · HIDDEN (skipped when presenting)" : ""));
  lines.push(`Canvas ${L.width}×${L.height} px, origin top left.` +
    (s.hasFooter && L.footerTop != null ? ` Footer rule at y=${L.footerTop}: keep content above it.` : ""));
  lines.push(`Ids below are relative: "/h2" means "${s.eid}/h2".`);
  for (const e of L.elements) {
    const id = e.eid === s.eid ? "(slide)" : e.eid.startsWith(s.eid + "/") ? e.eid.slice(s.eid.length) : e.eid;
    const geo = `x=${e.x} y=${e.y} w=${e.w} h=${e.h}`;
    const extra = [e.font ? `font ${e.font}` : "", e.hidden ? "hidden" : "", e.locked ? "brand-locked" : "",
      e.text ? `"${clip(e.text, 60)}"` : ""].filter(Boolean).join("  ");
    lines.push(pad("  ".repeat(e.depth) + id, 34) + pad(e.tag, 22) + pad(geo, 30) + extra);
  }
  lines.push(L.issues.length ? "Issues:\n" + L.issues.map((i) => "  - " + i).join("\n") : "Issues: none found");
  return lines.join("\n");
}

export function formatPin(p) {
  const s = p.slide;
  const lines = [`[${p.n}] slide ${s.index + 1} (${s.eid}) → ${p.eid} (${p.tag})` + (p.locked ? `  [${p.locked}]` : "")];
  const where = [`box x=${p.box.x} y=${p.box.y} w=${p.box.w} h=${p.box.h}`,
    `clicked at x=${p.point.x} y=${p.point.y} (${Math.round(p.at.fx * 100)}% across, ${Math.round(p.at.fy * 100)}% down the element)`];
  lines.push("    " + where.join("; "));
  const detail = [];
  if (p.word) detail.push(`word "${p.word}"`);
  if (p.cell) detail.push(`table cell row ${p.cell.row + 1}, column ${p.cell.col + 1} ("${clip(p.cell.text, 40)}")`);
  if (p.font) detail.push(`font ${p.font}`);
  if (detail.length) lines.push("    " + detail.join("; "));
  if (p.text) lines.push(`    text: "${clip(p.text, 100)}"`);
  return lines.join("\n");
}
