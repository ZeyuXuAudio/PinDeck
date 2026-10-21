/* Which slide framework a deck uses. PinDeck edits reveal.js decks: <section> slides inside an element
   with class "slides" (inside <div class="reveal">). Other frameworks are recognised by their markup and
   scripts, so the user gets a clear "not supported (yet)" before PinDeck changes anything, instead of an
   editor without slides. Only tags and scripts are looked at, never the slides' text, so a talk that
   mentions "impress.js" is not taken for one. */

import { parse, findSlides } from "./eids.mjs";

const OTHERS = [   // name, markers; the first match wins (Marp before bespoke.js, which it is built on)
  ["Marp", /\bmarpit\b|bespoke-marp|data-marpit|marp-cli/i],
  ["Slidev", /slidev/i],
  ["impress.js", /id=["']impress["']|impress(\.min)?\.js/i],
  ["remark", /remark(-latest)?(\.min)?\.js|remark\.create\s*\(/i],
  ["Spectacle", /<script[^>]+src=["'][^"']*spectacle/i],
  ["Shower", /class=["'][^"']*\bshower\b|shower-core/i],
  ["deck.js", /deck-container|deck\.core(\.min)?\.js/i],
  ["bespoke.js", /bespoke(\.min)?\.js|bespoke\.from\s*\(/i],
];

/* Tags and script contents only: the slides' text could name any framework */
const markup = (html) => [...String(html).matchAll(/<script\b[^>]*>[\s\S]*?<\/script>|<[^>]+>/gi)].map((m) => m[0]).join("\n");

/* { name, supported }: reveal.js decks are supported, including one without slides yet */
export function detectFramework(html) {
  if (findSlides(parse(html)).length) return { name: "reveal.js", supported: true };
  const tags = markup(html);
  const other = OTHERS.find(([, re]) => re.test(tags));
  if (other) return { name: other[0], supported: false };
  if (/class=["'][^"']*\breveal\b/i.test(tags) || /Reveal\.initialize\s*\(/.test(tags)) return { name: "reveal.js", supported: true };
  return { name: null, supported: false };
}

/* The message for a deck PinDeck cannot edit, or null */
export function unsupportedMessage(html, file) {
  const fw = detectFramework(html);
  if (fw.supported) return null;
  const what = fw.name ? `${file} is a ${fw.name} deck.` :
    `${file} has no reveal.js slides (a <div class="reveal"> with <div class="slides"> holding <section> slides).`;
  return `${what} PinDeck works with reveal.js decks only for now; other frameworks may follow. ` +
    `Nothing was changed.`;
}
