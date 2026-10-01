/* Deck runtime.
   1. Renders math with KaTeX (shared macros below).
   2. Injects the footer (authors, institute, short title, slide number, logo).
   3. Starts Reveal.js.
   4. Wires the audio demo (play buttons and the sweeping waveform cursor).
   Works from file:// with no network access. */

(function () {
  const root = document.querySelector(".reveal");
  const meta = root.dataset;

  /* ---- 1. Math ---------------------------------------------------------- */
  renderMathInElement(root, {
    delimiters: [
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
    ],
    throwOnError: false,
    macros: {                         // shared notation: define once, use on every slide
      "\\vect": "\\mathbf{#1}",
      "\\norm": "\\left\\lVert #1\\right\\rVert",
      "\\E": "\\mathbb{E}",
      "\\dd": "\\,\\mathrm{d}",
    },
  });

  /* ---- 2. Footer ---------------------------------------------------------- */
  const skip = ".title-slide, .section-slide, .closing-slide, .no-foot";
  document.querySelectorAll(".reveal .slides > section").forEach((section, i) => {
    if (section.matches(skip)) return;
    const foot = document.createElement("footer");
    foot.className = "slide-foot";
    foot.innerHTML =
      `<div class="f-left">${meta.authors || ""}${meta.institute ? " · " + meta.institute : ""}</div>` +
      `<div class="f-mid">${meta.shortTitle || ""}</div>` +
      `<div class="f-num">${String(i + 1).padStart(2, "0")}</div>` +
      `<img class="f-logo" src="assets/logo-placeholder-dark.svg" alt="">`;
    section.appendChild(foot);
  });

  /* ---- 3. Reveal ---------------------------------------------------------- */
  Reveal.initialize({
    width: 1280, height: 720, margin: 0, minScale: 0.2, maxScale: 3,
    center: false, controls: false, progress: false, slideNumber: false, hash: true,
    transition: "fade", transitionSpeed: "fast", backgroundTransition: "none",
    pdfSeparateFragments: false,   // print/PDF shows the final state of every slide
    plugins: [RevealNotes],
  });

  /* ---- 4. Audio demo ------------------------------------------------------ */
  const players = {};
  document.querySelectorAll(".play-btn").forEach((btn) => {
    const id = btn.dataset.target;
    const audio = document.getElementById("audio-" + id);
    const wave = document.getElementById("wave-" + id);
    const cursor = wave.querySelector(".cursor");
    const played = wave.querySelector(".played");
    let raf = null;

    const draw = () => {
      const p = audio.duration ? audio.currentTime / audio.duration : 0;
      cursor.style.left = `calc(${p * 100}% - 1.5px)`;
      played.style.width = `${p * 100}%`;
      if (!audio.paused) raf = requestAnimationFrame(draw);
    };
    const setState = (playing) => {
      btn.textContent = playing ? "Pause" : "Play";
      btn.setAttribute("aria-pressed", String(playing));
      wave.classList.toggle("playing", playing);
      wave.classList.toggle("paused", !playing && audio.currentTime > 0);
    };

    btn.addEventListener("click", () => {
      if (audio.paused) { Object.values(players).forEach((p) => p.pause()); audio.play(); }
      else audio.pause();
    });
    audio.addEventListener("play", () => { setState(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });
    audio.addEventListener("pause", () => { setState(false); draw(); });
    audio.addEventListener("ended", () => { audio.currentTime = 0; setState(false); wave.classList.remove("paused"); draw(); });
    wave.addEventListener("click", (e) => {
      const r = wave.getBoundingClientRect();
      if (audio.duration) { audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; draw(); }
    });
    players[id] = audio;
  });

  Reveal.on("slidechanged", () => Object.values(players).forEach((a) => a.pause()));
})();
