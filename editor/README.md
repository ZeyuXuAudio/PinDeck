# PinDeck

**Pin it. Say it. Done.** PinDeck is a local editor for HTML slide decks (reveal.js): the slides on
the left, the slide in the middle, and a chat with Claude Code on the right. You click elements to
pin them, write what to change, and Claude edits the HTML and CSS. The slide updates in place.

It is built for reveal.js decks. `audiolabs-example` is the reference deck; its specifics (the
locked `brand.css`, the footer rule at y = 647) are still built in and will move to a per-deck config.

```bash
npx pindeck path/to/deck        # once published on npm
node editor/server.mjs audiolabs-example   # from this repository
```

Then open <http://127.0.0.1:5180/>. Requirements: Node 20 or later and the `claude` CLI, signed in
with your normal Claude account. Chrome (or Chromium, Edge, Brave) is optional and is used for
screenshots. PinDeck has no npm dependencies.

Options: `--port 5180`, `--model <name>` (otherwise Claude Code's default model), `--help`. The deck
folder defaults to the current folder and must contain `index.html`. Runtime files (chat history,
screenshots, backups) are kept in `~/.pindeck/` (change with `PINDECK_HOME`), not in the deck.

## Working with it

| Action | How |
|---|---|
| Select, move, resize | Select mode (`V`, the default): click an element to select it, drag to move, pull a handle to resize. Elements snap to the slide edges and centre, the footer rule and other elements (pink guides); hold `Alt` to turn snapping off, `Shift` to move along one axis. Images keep their aspect ratio (`Shift` toggles). Arrow keys nudge by 1 px, `Shift`+arrows by 10 px. |
| Edit text | Double-click the text (or select it and press `Enter`). The element shows its source, so math appears as TeX, e.g. `\(\mu=0.5\)`. `Enter` or a click elsewhere saves, `Esc` cancels, `Shift+Enter` adds a line break, `⌘B` / `⌘I` make text bold or italic. In a bullet, `Enter` splits it at the cursor and continues in a new bullet below; `Enter` on an empty new bullet removes it and stops. Pasted text arrives as plain text. Table cells are edited one at a time. |
| Undo, redo | `⌘Z` / `⇧⌘Z` or the toolbar arrows. One history for your hand edits and Claude's changes. |
| Pin elements | Press `P` (or the Pin button), click elements; each click gets a number. Click a marker to remove it, `Esc` to stop. |
| Ask Claude | Write in the sidebar and refer to pins by number: "1: align with 2, make 3 smaller". The selected element is sent too, so "make this smaller" works. `Enter` sends, `Shift+Enter` adds a new line. |
| Visual questions | Tick "Include screenshot" to attach the current slide with the pin markers. |
| Review | Each answer ends with the changed files, a **Diff** button and an **Undo** button (most recent change). |
| Stop | **Stop** interrupts Claude; the conversation continues. **New chat** starts over. |
| Navigate | Slide list, `←` `→`, or the toolbar. **Present** opens the deck in a new tab. |

You can also edit `index.html` or `theme.css` in any editor; the slide reloads, and Claude is told
the files changed. CSS changes are swapped in without a reload.

## How it works

* **Element ids.** On start, the server gives every slide and every visible element a readable
  `data-eid` attribute (`summary`, `summary/callout`, `summary/li-2`). Only the attribute is
  inserted; the rest of the file stays as it was. A backup of the file before the first change is
  kept in `~/.pindeck/decks/<deck>/backups/`. Ids survive edits, so pins, layout reports and Claude all name
  the same element.
* **Hand edits.** A move is stored as the CSS `translate` property and a resize as `width`/`height`,
  inline on the element in `index.html`. `translate` moves an element without changing the layout
  around it, for elements in the flow and absolutely positioned ones alike. Only that one style
  attribute is rewritten; the rest of the file stays as it was. Claude gets a note about each hand
  edit. Brand-locked elements (footer, logos) cannot be selected.
* **Text edits.** While you type, the element holds its source HTML from `index.html`, not the
  rendered slide, so math stays TeX and nothing that KaTeX or the deck script generates ends up in
  the file. On save only that element's content is replaced. Browser editing artefacts are cleaned
  up: `<b>`/`<i>` become `<strong>`/`<em>`, styled spans from formatting are removed, trailing
  `<br>`s dropped.
* **Pins.** A pin records the element id, its box in slide coordinates (1280 x 720), the click
  point, the clicked word and, in tables, the cell. Pins on the footer or logos are marked as
  locked.
* **Layout instead of screenshots.** With each message the editor measures the current slide and
  every pinned slide in your browser: position and size of every element, font sizes, and issues
  (content below the footer rule, outside the slide, overlaps, clipped text). Claude gets this as
  text. To check its own work it runs `node ../editor/cli.mjs layout <slide>`. Screenshots are
  only taken when you tick the box or Claude needs a visual judgement.
* **One Claude Code process.** The server starts `claude -p` in stream-json mode once and keeps it
  running, so there is no start-up delay per message. It runs in the deck folder under your Claude
  login, with `--append-system-prompt` from `lib/system-prompt.md`.
* **Permissions.** Claude may read files, edit `index.html` and `theme.css`, and run the editor's
  CLI. Nothing else, and in particular no edits to `brand.css`. If `brand.css` changes during a
  turn anyway, the server restores it and says so in the chat.
* **Undo.** The server keeps a copy of the editable files from before each change (a Claude turn
  or a hand edit). Undo and redo walk that history and tell Claude on the next message.

## Files

| File | Purpose |
|---|---|
| `server.mjs` | Local server (127.0.0.1 only, random token per run): UI, deck files, events, Claude session, undo, CLI endpoints. |
| `cli.mjs` | `layout`, `shot` and `slides` commands for Claude (and for you). |
| `public/` | The editor page, and `bridge.js`, which is injected into the deck in edit mode (never saved to it). |
| `lib/eids.mjs` | Adds the `data-eid` attributes by editing the HTML as text. |
| `lib/claude.mjs` | The long-running Claude Code process. |
| `lib/system-prompt.md` | What Claude is told about the editor. |
| `LICENSE` | MIT. |

## Limits of version 1.3

* Text inside inline SVG diagrams cannot be edited in place; pin it and ask Claude.
* No indenting or outdenting of bullets with `Tab` yet, and `Backspace` at the start of a bullet does
  not merge it with the one above; ask Claude for those.
* Parts of an inline SVG move with the whole SVG; inline text (bold, spans) moves with its block.
* Moves are offsets (`translate`), so the space an element came from stays reserved. Ask Claude to
  turn hand edits into proper CSS when a layout should really change.
* The undo history lives in the server and starts fresh when PinDeck restarts.
* Headless Chrome on macOS can be slow to start; screenshots take about 1.5 s.

## Versions

* **1.3**: `Enter` in a bullet starts a new bullet (split at the cursor); empty new bullets
  are removed again.
* **1.2**: text editing on the slide (double-click or Enter), with math as TeX, table cells,
  bold and italic, plain-text paste; text edits are part of the undo history and reported to Claude.
* **1.1**: select, drag, resize and nudge with snapping guides; one undo/redo history for hand
  edits and Claude's changes; the selected element is sent to Claude.
* **1.0**: pins, chat with Claude Code, layout reports, element ids, diff and undo.

## License

MIT, see [LICENSE](LICENSE).
