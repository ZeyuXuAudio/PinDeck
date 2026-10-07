# Ocean slide template: rules for editing

- `index.html` holds the slides, `theme.css` the styles. `README.md` lists the layouts and classes.
- `brand.css` is the fixed identity (palette, backgrounds, waves, footer, logos). Do not edit it;
  say so if a request needs a brand change.
- The canvas is 1280 x 720 px. On content slides keep everything above the footer rule (y = 652).
- Keep new slide-level CSS rules scoped to `.reveal .slides section.slide`.
- Slide titles in Title Case; each content slide has a short `.kicker` above the title.
- Use the existing layouts and classes before adding new ones.
- Math is KaTeX: `\( ... \)` inline, `\[ ... \]` display; shared macros live in `deck.js`.

## Tables

`table.results` is booktabs-style: rules only at the top, under the header and at the bottom,
none between rows; text left, numbers right. Add `compact` for wide or long tables.

- Grouped column headings: `<th colspan="2">` in a first header row (it gets a short rule underneath);
  headings that span both header rows take `rowspan="2"`.
- Row groups: no `rowspan` in `<tbody>`. Put the group label in a `td.grp` on the group's first row,
  an empty `td.grp` in the rows below it, and `class="group"` on the first row of every later group.
- Highlight with row classes only: `.ours` (accent text on a tint), `.best` (accent text), `.focus`
  (tint), `.muted` (grey). No inline styles in tables; if a table needs another look, add a class to `theme.css`.

## Element ids (`data-eid`)

When the deck is opened in PinDeck (one folder up), every slide and visible element gets a
`data-eid` attribute. Keep ids unchanged when editing an element. Give new elements
`data-eid="<slide-id>/<short-name>"` and new slides a new id (a slug of the title).

## Checking layout

When PinDeck is running (`node ../server.mjs .`):

- `node ../cli.mjs layout <slide-id or number>`: measured boxes, font sizes and layout issues.
- `node ../cli.mjs shot <slide-id or number>`: PNG screenshot; prints the path.
- `node ../cli.mjs slides`: slide numbers and ids.
