# PinDeck

**Pin it. Say it. Done.** PinDeck is a local editor for HTML slide decks (reveal.js): the slides on
the left, the slide in the middle, and a chat with Claude Code on the right. You click elements to
pin them, write what to change, and Claude edits the HTML and CSS. The slide updates in place.

It is built for reveal.js decks; `ocean-example/` is a complete example deck.

```bash
npx pindeck path/to/deck        # once published on npm
node server.mjs ocean-example   # from this repository
```

Then open <http://127.0.0.1:5180/>. Requirements: Node 20 or later and the `claude` CLI, signed in
with your normal Claude account. Chrome (or Chromium, Edge, Brave) is optional and is used for
screenshots. PinDeck has no npm dependencies.

Options: `--port 5180`, `--model <name>` (for this run only; otherwise the model in `~/.pindeck/config.json`), `--help`. The deck
folder defaults to the current folder and must contain `index.html`. Runtime files (chat history,
screenshots, backups) are kept in `~/.pindeck/` (change with `PINDECK_HOME`), not in the deck.

## Preparing a deck

PinDeck works with reveal.js decks whose slides are `<section>` elements inside `.slides`. Two
optional `<meta>` tags in the deck's `<head>` tell it about the design:

```html
<meta name="pindeck:footer-top" content="652">          <!-- y of the footer rule: content must stay above it -->
<meta name="pindeck:locked" content=".slide-foot, .logo"> <!-- brand elements that cannot be selected or moved -->
```

Hidden slides use reveal.js's `data-visibility="hidden"`. If the deck numbers its slides itself (as
the example's `deck.js` does for the footer), count only slides without that attribute, or the
numbers will jump where a slide is hidden.

Without them PinDeck runs no footer check and locks only `.slide-foot` and `.logo`. A file called
`brand.css` in the deck folder is locked for Claude. See `ocean-example/` for a complete deck.

## Configuration

`~/.pindeck/config.json` (or `$PINDECK_HOME/config.json`) is created on first start:

```json
{
  "model": "sonnet",
  "effort": "medium"
}
```

`model` is `opus` or `sonnet`; `effort` is `low`, `medium`, `high`, `xhigh` or `max`. A choice in the
chat header's menu is written to this file, so it always shows what PinDeck uses. Edit it while
PinDeck is stopped, or simply use the menu.

## Keeping the ids out of git

PinDeck adds `data-eid` attributes to the deck it opens. If the deck is in git, run once per clone:

```bash
node cli.mjs git-setup path/to/deck
```

This adds a line like `path/to/deck/*.html filter=pindeck-ids` to `.gitattributes` (commit it) and
defines the filter in the clone's git config: git then strips the ids whenever it reads the deck's
HTML. The ids stay in the file on disk, where PinDeck and Claude need them, but commits and diffs
never contain them, and a change that only adds ids does not show in `git status`. Your own edits
show and commit as usual. Clones without the filter configured simply see the file as it is.

## Working with it

| Action | How |
|---|---|
| Select, move, resize | Select mode (`V`, the default): click an element to select it, drag to move, pull a handle to resize. Elements snap to the slide edges and centre, the footer rule and other elements (pink guides); hold `Alt` to turn snapping off, `Shift` to move along one axis. Images keep their aspect ratio (`Shift` toggles). Arrow keys nudge by 1 px, `Shift`+arrows by 10 px. `Delete` removes the selected element after a confirmation; a picture goes with its caption, and files nothing else in the deck uses can be deleted with it. `⌘Z` brings both back. |
| Edit text | Double-click the text (or select it and press `Enter`). The element shows its source, so math appears as TeX, e.g. `\(\mu=0.5\)`. `Enter` or a click elsewhere saves, `Esc` cancels, `Shift+Enter` adds a line break, `⌘B` / `⌘I` make text bold or italic. In a bullet, `Enter` splits it at the cursor and continues in a new bullet below; `Enter` on an empty new bullet removes it and stops. Pasted text arrives as plain text. Table cells are edited one at a time. |
| Undo, redo | `⌘Z` / `⇧⌘Z` or the toolbar arrows. One history for your hand edits and Claude's changes. |
| Pin elements | Press `P` (or the Pin button), click elements; each click gets a number. Click a marker to remove it, `Esc` to stop. |
| Ask Claude | Write in the sidebar and refer to pins by number: "1: align with 2, make 3 smaller". The selected element is sent too, so "make this smaller" works. `Enter` sends, `Shift+Enter` adds a new line. |
| Visual questions | **+** in the chat, then **Screenshot**: the current slide with its pin markers is attached when you send. |
| Review | Each answer ends with the changed files, a **Diff** button and an **Undo** button (most recent change). |
| Stop | **Stop** interrupts Claude; the conversation continues. **New chat** starts over. |
| New slide | **＋ New slide** above the slide list: a **content slide** (title and bullets), a **section divider**, or a **duplicate** of the current slide. It is added after the current slide, modelled on the deck's own slides, and its title opens for typing. |
| Import from PowerPoint | **＋ New slide** → **Import from PowerPoint…**, then choose a `.pptx` file and tick the slides you want (hidden PowerPoint slides start unticked). They are added after the current slide in this deck's own layouts, and Claude can improve the complex ones; see [PowerPoint import](#powerpoint-import). `⌘Z` removes them again, with their figures. |
| Move a slide | Drag it up or down in the slide list; an orange line shows where it will go. It moves with its notes and the comment above it, and `⌘Z` puts it back. Slides inside vertical stacks cannot be moved yet. |
| Hide a slide | The eye on a slide in the list, or `H`. A hidden slide stays in the deck and in PinDeck (greyed out, with a banner) but is skipped when presenting and in PDFs; **Export ▾** can include hidden slides. Show it the same way. |
| Model and effort | Click **Claude ▾** in the chat header: Opus or Sonnet, and the effort (how long Claude thinks: low to max). The conversation continues after a change. The choice is saved in `~/.pindeck/config.json` (default: Sonnet, medium). |
| Attach figures and audio | **+** in the chat, then **File…**, drag and drop onto the chat or a slide, or paste an image. Files are saved in `<deck>/figures/` straight away; audio also gets a waveform SVG. Then ask Claude, e.g. "put this figure on a new slide after 4". Removing an attachment before sending deletes the file again. |
| Export PDF | **Export ▾** in the toolbar. **Handout PDF**: one page per slide, build steps shown complete. **Presentation PDF**: one page per click, so a slide with two build steps gives three pages. Files go to `<deck>/export/`. Needs Chrome or Chromium. |
| Navigate | Slide list, `←` `→`, or the toolbar. **Present** opens the deck in a new tab. |

You can also edit `index.html` or `theme.css` in any editor; the slide reloads, and Claude is told
the files changed. CSS changes are swapped in without a reload.

## PowerPoint import

The import keeps what can be carried over exactly and makes pictures of the rest:

* **Text becomes HTML** in the deck's layouts: the title (and the subtitle, as a `.sub` line or a
  kicker, as the deck does it), bullets with their levels, bold, italics, coloured words (as `.hl`),
  superscripts, links and line breaks, other text as paragraphs, references at the bottom of a slide
  as `.refs`, and the speaker notes. Side notes and labels clearly smaller than the body text stay smaller.
* **Tables become HTML tables** with the class of the deck's own tables, merged cells, header rows
  and a caption from the text above them. A table with shapes drawn over it (e.g. boxes marking rows)
  is kept as a picture instead.
* **Build steps:** shapes and paragraphs that appear (or disappear) on a click become reveal.js
  fragments in the same order, also when several things appear on one click. A picture made of several
  shapes appears on a click only if all of its shapes do.
* **Audio** goes into the deck's own audio player (a copy of its first `.demo-row`, with a waveform made
  from the sound), labelled with the nearest text on the slide; without such a player, plain players.
  **Video** keeps its place, with its poster frame.
  The first slide is filled into the deck's title slide (title, subtitle, authors, event, institute)
  and PowerPoint section headers into its section divider.
* **Pictures are copied** to `figures/` (`<file>-s04-1.png`, ...).
* **Everything drawn** (diagrams built from shapes and arrows, charts, pictures with labels on
  them, EMF graphics) becomes a picture cut from the slide as PowerPoint renders it. For this PinDeck
  asks PowerPoint (or else Keynote) to save the presentation as a PDF; macOS asks once whether PinDeck
  may control the app. The same PDF gives the thumbnails in the import dialog.
* **Layout:** blocks that sit side by side become `.cols` with the slide's proportions, others are
  stacked top to bottom; figures and, if needed, the text are scaled so that the slide fits.
* **Equations** (PowerPoint's equation editor) become TeX for the deck's KaTeX: `\( \)` in the text,
  `\[ \]` on their own line; fractions, scripts, roots, sums and integrals, functions and limits,
  accents, braces, matrices and the bold, italic and double-struck math letters are converted.
* **Hidden slides** stay hidden (`data-visibility="hidden"`).

**Hand-off to Claude.** Slides the import can only approximate are tagged *complex* in the dialog:
diagrams of many shapes or tables with shapes over them that became pictures, pictures placed inside
text (often equations as images), build steps on parts of a diagram, slides without a title, and
text that had to shrink to fit. With **Then ask Claude to improve the complex slides** ticked, Claude
gets these slides right after the import, each with a picture of the original slide and the texts of
its diagrams, and rebuilds diagrams as SVG, equations as TeX and tables as HTML in the deck's style.
The request shows in the chat like your own messages, and its changes can be undone as usual.

Without PowerPoint or Keynote (or on other systems than macOS) only the text and the pictures are imported.

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
  text. To check its own work it runs `node ../cli.mjs layout <slide>...` (`--issues` for the
  issues only). Screenshots are
  only taken when you tick the box or Claude needs a visual judgement.
* **One Claude Code process.** The server starts `claude -p` in stream-json mode once and keeps it
  running, so there is no start-up delay per message. It runs in the deck folder under your Claude
  login, with `--append-system-prompt` from `lib/system-prompt.md` and the deck's `CLAUDE.md`.
* **Permissions.** Claude may read files, edit `index.html` and `theme.css`, and run the editor's
  CLI. Nothing else, and in particular no edits to `brand.css`. Claude Code loads no settings files
  and no MCP servers, so no allow rule in your own, the deck's or a parent folder's settings widens this. If `brand.css` changes during a
  turn anyway, the server restores it and says so in the chat.
* **Undo.** The server keeps a copy of the editable files from before each change (a Claude turn
  or a hand edit). Undo and redo walk that history and tell Claude on the next message.

## Files

| File | Purpose |
|---|---|
| `server.mjs` | Local server (127.0.0.1 only, random token per run): UI, deck files, events, Claude session, undo, CLI endpoints. |
| `cli.mjs` | `layout`, `shot`, `slides` and `pdf handout` / `pdf presentation` commands for Claude (and for you), and `git-setup`. |
| `public/` | The editor page, and `bridge.js`, which is injected into the deck in edit mode (never saved to it). |
| `lib/pptx.mjs`, `lib/zip.mjs`, `lib/xml.mjs` | Reading `.pptx` files (no dependencies): slides, text, shapes and their positions, notes. |
| `lib/pptx-import.mjs` | Turns PowerPoint slides into slides of the deck: figures, tables, build steps, audio, layout, HTML in the deck's style. |
| `lib/waveform.mjs` | Waveform SVGs for imported audio. |
| `lib/omml.mjs` | PowerPoint equations (Office Math) to TeX. |
| `lib/pptx-render.mjs`, `lib/pdf-render.jxa.js` | Slide pictures: PowerPoint or Keynote saves a PDF, macOS PDFKit renders pages and regions of it. |
| `lib/pdf.mjs` | PDF export: reveal.js print layout in headless Chrome, then print to PDF. |
| `lib/eids.mjs` | Adds the `data-eid` attributes by editing the HTML as text. |
| `lib/claude.mjs` | The long-running Claude Code process. |
| `lib/system-prompt.md` | What Claude is told about the editor. |
| `LICENSE` | MIT. |

## Current Limitations

* Text inside inline SVG diagrams cannot be edited in place; pin it and ask Claude.
* Parts of an inline SVG move with the whole SVG; inline text (bold, spans) moves with its block.
* No indenting or outdenting of bullets with `Tab` yet, and `Backspace` at the start of a bullet does not merge it with the one above; ask Claude for those.
* Moves are offsets (`translate`), so the space an element came from stays reserved. Ask Claude to turn hand edits into proper CSS when a layout should really change.
* The undo history lives on the server and starts fresh when PinDeck restarts.

## Versions

* **2.4**: move slides by dragging them in the slide list; undo puts them back.
* **2.3**: lessons from a PowerPoint hand-off. Claude Code runs without settings files or MCP servers
  (the deck's `CLAUDE.md` goes into the system prompt instead), so stray allow rules no longer let it run
  scripts; `layout` takes several slides and `--issues`; the chat no longer labels a refused script as a
  layout check; shared SVG arrowheads live outside the slides, where hidden slides cannot hide them.
* **2.2**: PowerPoint import with equations as TeX for KaTeX, and the hand-off to Claude: complex slides are
  tagged in the import dialog and, if wanted, improved by Claude right after the import, with a picture of
  each original slide.
* **2.1**: PowerPoint import with build steps (fragments in click order), HTML tables in the deck's table
  style, audio in the deck's player with a waveform, video with its poster, coloured words as `.hl`.
* **2.0**: import slides from PowerPoint (`.pptx`): text as HTML in the deck's layouts, pictures copied,
  diagrams, tables and charts as pictures cut from PowerPoint's rendering; thumbnails in the import
  dialog; undo removes the imported slides and their figures.
* **1.12.1**: the PinDeck pin as the browser tab icon (SVG, with PNG versions for Safari).
* **1.12**: double-clicking an equation opens its text with the equation's TeX selected, also for
  equations on their own line and for parts KaTeX draws as SVG (roots, wide accents, arrows).
* **1.11.3**: a calmer interface: no slide count, no Hide/Show button in the header (eye and `H`
  remain), no messages or chat entries for hiding and showing, shorter export descriptions.
* **1.11.2**: the header shows the deck's name instead of the slide title; the browser tab is named after the deck.
* **1.11.1**: the Hide and Show icons sit at the same height.
* **1.11**: hide and show slides (eye in the slide list, toolbar button, `H`); hidden slides are skipped
  when presenting and in PDFs unless the export includes them.
* **1.10**: model and effort without "Default" entries (default Sonnet, medium), set in `~/.pindeck/config.json`.
* **1.9**: `node cli.mjs git-setup` keeps PinDeck's ids out of git with a clean filter; id-only changes no longer show in `git status`.
* **1.8**: ＋ New slide (content slide, section divider, duplicate); model (Opus, Sonnet) and effort menu in the chat header; a + menu in the chat for files and screenshots.
* **1.7**: `Delete` removes the selected element after a confirmation, a picture with its caption, and optionally the files nothing else uses; undo restores elements and files. Claude reads attached images directly instead of trying to convert them; refused commands are explained in the chat.
* **1.6**: attach figures and audio to chat messages (file picker, drag and drop, paste); audio gets a waveform SVG; files dropped on a slide carry their position.
* **1.5**: PDF export (handout and presentation with build steps on separate pages).
* **1.4**: decks describe their footer and locked brand elements with `<meta name="pindeck:...">` tags; the layout check ignores invisible elements. New public example deck: `ocean-example/`.
* **1.3**: `Enter` in a bullet starts a new bullet (split at the cursor); empty new bullets are removed again.
* **1.2**: text editing on the slide (double-click or Enter), with math as TeX, table cells, bold and italic, plain-text paste; text edits are part of the undo history and reported to Claude.
* **1.1**: select, drag, resize and nudge with snapping guides; one undo/redo history for hand edits and Claude's changes; the selected element is sent to Claude.
* **1.0**: pins, chat with Claude Code, layout reports, element ids, diff and undo.

## License

MIT, see [LICENSE](LICENSE).
