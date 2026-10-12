# Contributing to PinDeck

Thanks for helping. Bug reports, ideas, example decks and pull requests are all welcome.

## Reporting a bug

Open an issue with:

* what you did, what you expected and what happened instead;
* the PinDeck version (`package.json`), Node version, operating system and browser;
* the terminal output of `node server.mjs`, and errors from the browser console if there are any;
* if a deck is involved: the smallest piece of `index.html` (and `theme.css`) that shows the problem;
* for the PowerPoint import: a small `.pptx` with only the slide that goes wrong, if you can share it.

Do not attach decks or slides you may not share. Chat history and backups in `~/.pindeck/` can contain
your slides' text, so check before you attach anything from there.

## Suggesting a feature

Open an issue first and describe the situation it helps with. PinDeck tries to stay small: one page,
a chat, and edits that change only what they must in the deck's own files. A short discussion before
the code saves work on both sides.

## Setting up

```bash
git clone <this repository>
cd pindeck
node cli.mjs git-setup ocean-example   # keep PinDeck's data-eid ids out of your commits
node server.mjs ocean-example          # then open http://127.0.0.1:5180/
```

There is nothing to install: PinDeck has no npm dependencies. You need Node 20 or later and the
`claude` CLI; Chrome is used for screenshots and PDF export, PowerPoint or Keynote (macOS) for the
pictures in the PowerPoint import.

Useful while developing:

* `PINDECK_HOME=/tmp/pindeck-dev` keeps chat history, backups and settings away from your own `~/.pindeck`.
* Work on a copy of a deck (`cp -R ocean-example /tmp/deck`) when you try things that change it.
* `--port` runs a second PinDeck next to your usual one; `CLAUDE_BIN` and `CHROME_BIN` point to other binaries.

## Making a change

* **No dependencies.** Everything is plain JavaScript (ES modules) on Node's standard library and the
  browser. Please keep it that way; a small helper in `lib/` is better than a package.
* **Edit the deck as text.** PinDeck changes only the attribute, style or element it means to and
  leaves the rest of the file exactly as it was (see `lib/eids.mjs`). New code that writes to a deck
  should do the same.
* **Keep Claude's permissions narrow.** Claude may edit `index.html` and `theme.css` and run `cli.mjs`,
  nothing else; `brand.css` is locked. The server listens on 127.0.0.1 only and every API call needs
  the per-run token. Changes that widen any of this need a good reason in the pull request.
* **Match the code around it:** short functions, comments that say why, plain wording in the UI and
  the README.
* **Document what users see.** Update the README: the "Working with it" table for new actions, "Current
  Limitations" when one goes away, and a line for the "Versions" list in your pull request. The
  maintainer assigns the version number.

## Testing

There is no automated test suite yet, so please check your change by hand before you open a pull request:

1. `node --check` on the files you changed.
2. Run PinDeck on `ocean-example/` and, if you have one, a deck of your own (copies, if your change
   edits the deck) and go through what your change touches, for example:
   * select, move, resize and nudge an element, then undo and redo;
   * edit text (also math, a table cell, and Enter in a bullet) and speaker notes;
   * pin elements and send a message; check the layout with `node cli.mjs layout <slide> --issues`;
   * add, duplicate, hide, move and delete slides;
   * export a handout and a presentation PDF;
   * import slides from a PowerPoint file, if you changed `lib/pptx*.mjs`, `lib/omml.mjs` or `lib/zip.mjs`.
3. Check that the deck file changed only where it should (`git diff` with the git filter set up).

Tests that run without Claude or a browser, for example for `lib/eids.mjs` or the PowerPoint import,
are a very welcome contribution in themselves.

## Pull requests

* One topic per pull request, with a short description of what changes for the user and how you tested it.
* Keep commits free of `data-eid` attributes in the example decks (`node cli.mjs git-setup` takes care of that).
* By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
