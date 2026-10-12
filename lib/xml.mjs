/* Tiny XML parser for Office Open XML: elements, attributes and text, nothing more.
   Names keep their prefixes ("p:sp", "a:t"); entities are decoded. */

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== "#") return ENT[e] ?? m;
  const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";   // no such character: a stand-in, not an error
});

export function parseXml(src) {
  const root = { name: "#doc", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.children.push({ text: m[1] }); continue; }
    if (m[6] !== undefined) { if (top !== root) top.children.push({ text: decode(m[6]) }); continue; }
    if (!m[3]) continue;   // comment or processing instruction
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }   // a stray closing tag never closes the document
    const el = { name: m[3], attrs: {}, children: [] };
    for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = decode(a[2] ?? a[3]);
    top.children.push(el);
    if (!m[5]) stack.push(el);
  }
  return root;
}

/* Helpers on parsed elements */
export const kids = (el, name) => (el?.children || []).filter((c) => c.name && (!name || c.name === name));
export const kid = (el, name) => (el?.children || []).find((c) => c.name === name) || null;
export function path(el, ...names) {
  let cur = el;
  for (const n of names) { cur = kid(cur, n); if (!cur) return null; }
  return cur;
}
export function find(el, name) {   // first descendant with this name
  for (const c of el?.children || []) {
    if (!c.name) continue;
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}
export function findAll(el, name, out = []) {
  for (const c of el?.children || []) {
    if (!c.name) continue;
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
export const textOf = (el) => (el?.children || []).map((c) => (c.text != null ? c.text : textOf(c))).join("");
