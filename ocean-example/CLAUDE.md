# Ocean slide template: rules for editing

- `index.html` holds the slides, `theme.css` the styles. `README.md` lists the layouts and classes.
- `brand.css` is the fixed identity (palette, backgrounds, waves, footer, logos). Do not edit it;
  say so if a request needs a brand change.
- The canvas is 1280 x 720 px. On content slides keep everything above the footer rule (y = 652).
- Keep new slide-level CSS rules scoped to `.reveal .slides section.slide`.
- Slide titles in Title Case; each content slide has a short `.kicker` above the title.
- Use the existing layouts and classes before adding new ones.
- Math is KaTeX: `\( ... \)` inline, `\[ ... \]` display; shared macros live in `deck.js`.

## Element ids (`data-eid`)

When the deck is opened in PinDeck (one folder up), every slide and visible element gets a
`data-eid` attribute. Keep ids unchanged when editing an element. Give new elements
`data-eid="<slide-id>/<short-name>"` and new slides a new id (a slug of the title).

## Checking layout

When PinDeck is running (`node ../server.mjs .`):

- `node ../cli.mjs layout <slide-id or number>`: measured boxes, font sizes and layout issues.
- `node ../cli.mjs shot <slide-id or number>`: PNG screenshot; prints the path.
- `node ../cli.mjs slides`: slide numbers and ids.
