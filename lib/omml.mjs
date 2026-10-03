/* Office Math (OMML, as in PowerPoint and Word) to LaTeX for KaTeX.
   Covers what equations in slides use: fractions, scripts, roots, delimiters, sums and integrals,
   functions, limits, accents, bars, braces, matrices, equation arrays, and the Unicode math letters
   (bold, italic, double-struck, ...). Anything unknown falls back to its text. */

import { kid, kids, textOf } from "./xml.mjs";

const GREEK = { α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "varepsilon", ϵ: "epsilon", ζ: "zeta", η: "eta", θ: "theta", ϑ: "vartheta",
  ι: "iota", κ: "kappa", ϰ: "varkappa", ϴ: "Theta", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi", ϖ: "varpi", ρ: "rho", ϱ: "varrho", σ: "sigma", ς: "varsigma",
  τ: "tau", υ: "upsilon", φ: "varphi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega", Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda",
  Ξ: "Xi", Π: "Pi", Σ: "Sigma", Υ: "Upsilon", Φ: "Phi", Ψ: "Psi", Ω: "Omega" };
const SYMBOLS = { Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", ο: "o", "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "≃": "\\simeq", "≅": "\\cong",
  "∝": "\\propto", "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊆": "\\subseteq", "⊃": "\\supset", "⊇": "\\supseteq",
  "∩": "\\cap", "∪": "\\cup", "∅": "\\emptyset", "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "×": "\\times", "÷": "\\div",
  "⋅": "\\cdot", "·": "\\cdot", "∙": "\\cdot", "±": "\\pm", "∓": "\\mp", "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow",
  "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↦": "\\mapsto", "∀": "\\forall", "∃": "\\exists", "¬": "\\neg",
  "∧": "\\wedge", "∨": "\\vee", "⊗": "\\otimes", "⊕": "\\oplus", "⊙": "\\odot", "∘": "\\circ", "∗": "\\ast", "⋆": "\\star",
  "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots", "⋱": "\\ddots", "′": "'", "″": "''", "°": "^\\circ", "−": "-", "∣": "\\mid",
  "‖": "\\|", "⊥": "\\perp", "∥": "\\parallel", "∠": "\\angle", "ℓ": "\\ell", "ℏ": "\\hbar", "ℜ": "\\Re", "ℑ": "\\Im",
  "⟨": "\\langle", "⟩": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "∑": "\\sum", "∏": "\\prod",
  "∫": "\\int", "∮": "\\oint", "√": "\\surd", "≪": "\\ll", "≫": "\\gg", "≜": "\\triangleq", "≔": ":=", "⊤": "\\top", "†": "\\dagger",
  "ℝ": "\\mathbb{R}", "ℂ": "\\mathbb{C}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℍ": "\\mathbb{H}", "ℙ": "\\mathbb{P}",
  "ℎ": "h", "ℬ": "\\mathcal{B}", "ℰ": "\\mathcal{E}", "ℱ": "\\mathcal{F}", "ℋ": "\\mathcal{H}", "ℐ": "\\mathcal{I}", "ℒ": "\\mathcal{L}",
  "ℳ": "\\mathcal{M}", "ℛ": "\\mathcal{R}", "{": "\\{", "}": "\\}", "%": "\\%", "#": "\\#", "&": "\\&", "_": "\\_", "$": "\\$",
  "\\": "\\backslash ", "~": "\\sim " };

/* Unicode mathematical alphanumerics (U+1D400 ...): style and plain letter */
const LATIN_STYLES = [[0x1d400, "mathbf"], [0x1d434, ""], [0x1d468, "boldsymbol"], [0x1d49c, "mathcal"], [0x1d4d0, "mathcal"],
  [0x1d504, "mathfrak"], [0x1d538, "mathbb"], [0x1d56c, "mathfrak"], [0x1d5a0, "mathsf"], [0x1d5d4, "mathsf"], [0x1d608, "mathsf"],
  [0x1d63c, "mathsf"], [0x1d670, "mathtt"]];
// each style has 26 capitals (with ϴ and ∇) and 32 small letters (with ∂ϵϑϰϕϱϖ)
const GREEK_UPPER = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇", GREEK_LOWER = "αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ";
function mathLetter(cp) {
  if (cp >= 0x1d400 && cp < 0x1d6a4) {
    const i = Math.floor((cp - 0x1d400) / 52), r = (cp - 0x1d400) % 52;
    const [, style] = LATIN_STYLES[i] || [, ""];
    return { style, ch: String.fromCharCode(r < 26 ? 65 + r : 97 + r - 26) };
  }
  if (cp >= 0x1d6a8 && cp < 0x1d7ca) {   // Greek: bold, italic, bold italic, sans bold, sans bold italic
    const i = Math.floor((cp - 0x1d6a8) / 58), r = (cp - 0x1d6a8) % 58;
    const ch = r < 26 ? GREEK_UPPER[r] : GREEK_LOWER[r - 26];
    return { style: ["boldsymbol", "", "boldsymbol", "boldsymbol", "boldsymbol"][i], ch };
  }
  if (cp >= 0x1d7ce && cp <= 0x1d7ff) {
    const i = Math.floor((cp - 0x1d7ce) / 10);
    return { style: ["mathbf", "mathbb", "mathsf", "mathsf", "mathtt"][i], ch: String((cp - 0x1d7ce) % 10) };
  }
  return null;
}

/* Text of a math run: letters as they are, symbols as commands, styled letters grouped */
function textToTex(s, sty) {
  let out = "", group = null, buf = "";
  const flush = () => { if (buf) out += group ? `\\${group}{${buf}}` : buf; buf = ""; };
  for (const c of s) {
    const ml = mathLetter(c.codePointAt(0));
    let style = ml ? ml.style : "", tex = ml ? ml.ch : c;
    if (!ml && sty === "b" && /[A-Za-z0-9]/.test(c)) style = "mathbf";
    if (!ml && sty === "bi" && /[A-Za-z]/.test(c)) style = "boldsymbol";
    if (GREEK[tex]) tex = `\\${GREEK[tex]} `;
    else if (SYMBOLS[tex]) tex = SYMBOLS[tex] + (/[a-z]$/i.test(SYMBOLS[tex]) ? " " : "");
    if (style !== group) { flush(); group = style; }
    buf += tex;
  }
  flush();
  return out.replace(/ +$/, " ");
}

const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln",
  "lg", "exp", "lim", "max", "min", "sup", "inf", "arg", "det", "dim", "ker", "deg", "gcd", "Pr", "liminf", "limsup", "argmax", "argmin"]);
const NARY = { "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint",
  "⋃": "\\bigcup", "⋂": "\\bigcap", "⋁": "\\bigvee", "⋀": "\\bigwedge", "⨁": "\\bigoplus", "⨂": "\\bigotimes" };
const ACCENTS = { "̂": "hat", "̃": "tilde", "̄": "bar", "̅": "overline", "⃗": "vec", "⃑": "vec", "̇": "dot",
  "̈": "ddot", "̌": "check", "́": "acute", "̀": "grave", "̆": "breve", "˜": "tilde", "^": "hat", "~": "tilde" };
const DELIMS = { "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", "‖": "\\|", "⟨": "\\langle", "⟩": "\\rangle",
  "〈": "\\langle", "〉": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "": "." };

const val = (pr, name, fallback = null) => kid(pr, name)?.attrs["m:val"] ?? fallback;
const brace = (s) => (s.length === 1 || /^\\[a-zA-Z]+ ?$/.test(s) ? s.trim() : `{${s}}`);

function conv(el) {
  if (!el) return "";
  if (el.text != null) return "";
  const c = (name) => conv(kid(el, name));
  const all = () => (el.children || []).filter((x) => x.name && !x.name.endsWith("Pr")).map(conv).join("");
  switch (el.name) {
    case "m:r": {
      const t = textOf(kid(el, "m:t"));
      const rPr = kid(el, "m:rPr");
      if (rPr && kid(rPr, "m:nor")) return `\\text{${t.replace(/[{}\\]/g, "")}}`;
      const sty = val(rPr, "m:sty");
      const tex = textToTex(t, sty);
      if (sty === "p" && /^[A-Za-z]{2,}$/.test(t)) return FUNCTIONS.has(t) ? `\\${t} ` : `\\mathrm{${t}}`;
      return tex;
    }
    case "m:f": {
      const type = val(kid(el, "m:fPr"), "m:type", "bar");
      const num = c("m:num"), den = c("m:den");
      if (type === "lin") return `${brace(num)}/${brace(den)}`;
      if (type === "noBar") return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`;
      return `\\frac{${num}}{${den}}`;
    }
    case "m:sSup": return `${brace(c("m:e"))}^{${c("m:sup")}}`;
    case "m:sSub": return `${brace(c("m:e"))}_{${c("m:sub")}}`;
    case "m:sSubSup": return `${brace(c("m:e"))}_{${c("m:sub")}}^{${c("m:sup")}}`;
    case "m:sPre": return `{}_{${c("m:sub")}}^{${c("m:sup")}}${brace(c("m:e"))}`;
    case "m:rad": {
      const hide = val(kid(el, "m:radPr"), "m:degHide") === "1" || val(kid(el, "m:radPr"), "m:degHide") === "on";
      const deg = c("m:deg");
      return hide || !deg ? `\\sqrt{${c("m:e")}}` : `\\sqrt[${deg}]{${c("m:e")}}`;
    }
    case "m:d": {
      const pr = kid(el, "m:dPr");
      const beg = val(pr, "m:begChr", "("), end = val(pr, "m:endChr", ")"), sep = val(pr, "m:sepChr", "|");
      const parts = kids(el, "m:e").map(conv);
      const d = (ch) => DELIMS[ch] ?? (SYMBOLS[ch] || ch);
      const sepTex = sep === "|" ? "\\mid " : d(sep);
      return `\\left${d(beg)} ${parts.join(sepTex === "," ? ", " : ` ${sepTex} `)} \\right${d(end)}`;
    }
    case "m:nary": {
      const pr = kid(el, "m:naryPr");
      const chr = val(pr, "m:chr", "∫");
      const op = NARY[chr] || SYMBOLS[chr] || chr;
      const hidden = (n) => ["1", "on", "true"].includes(val(pr, n));
      const lim = val(pr, "m:limLoc") === "undOvr" && /int/.test(op) ? "\\limits" : "";
      const sub = hidden("m:subHide") ? "" : c("m:sub"), sup = hidden("m:supHide") ? "" : c("m:sup");
      return `${op}${lim}${sub ? `_{${sub}}` : ""}${sup ? `^{${sup}}` : ""} ${c("m:e")}`;
    }
    case "m:func": {
      const name = conv(kid(el, "m:fName")).trim();
      const plain = name.replace(/\\mathrm\{([a-z]+)\}/gi, "$1");
      const head = /^[A-Za-z]+$/.test(plain) ? (FUNCTIONS.has(plain) ? `\\${plain}` : `\\operatorname{${plain}}`) : name;
      return `${head}${/^\\[a-z]+$/i.test(head) ? " " : ""}${brace(c("m:e"))}`;
    }
    case "m:limLow": {
      const e = c("m:e").trim(), lim = c("m:lim");
      if (/^\\(lim|max|min|sup|inf|argmax|argmin|operatorname\{[^}]+\})\s*$/.test(e) || FUNCTIONS.has(e.replace(/^\\/, ""))) return `${e.startsWith("\\") ? e : "\\" + e}_{${lim}}`;
      return `\\underset{${lim}}{${e}}`;
    }
    case "m:limUpp": return `\\overset{${c("m:lim")}}{${c("m:e")}}`;
    case "m:acc": {
      const chr = val(kid(el, "m:accPr"), "m:chr", "̂");
      return `\\${ACCENTS[chr] || "hat"}{${c("m:e")}}`;
    }
    case "m:bar": return val(kid(el, "m:barPr"), "m:pos", "bot") === "top" ? `\\overline{${c("m:e")}}` : `\\underline{${c("m:e")}}`;
    case "m:groupChr": {
      const pr = kid(el, "m:groupChrPr");
      const chr = val(pr, "m:chr", "⏟"), top = val(pr, "m:pos", "bot") === "top";
      if (chr === "⏞" || (top && chr === "⏟")) return `\\overbrace{${c("m:e")}}`;
      if (chr === "⏟") return `\\underbrace{${c("m:e")}}`;
      return top ? `\\overset{${SYMBOLS[chr] || chr}}{${c("m:e")}}` : `\\underset{${SYMBOLS[chr] || chr}}{${c("m:e")}}`;
    }
    case "m:borderBox": return `\\boxed{${c("m:e")}}`;
    case "m:eqArr": return `\\begin{aligned}${kids(el, "m:e").map((e) => conv(e).replace(/(^|[^\\])&/, "$1&")).join(" \\\\ ")}\\end{aligned}`;
    case "m:m": return `\\begin{matrix}${kids(el, "m:mr").map((r) => kids(r, "m:e").map(conv).join(" & ")).join(" \\\\ ")}\\end{matrix}`;
    case "m:oMathPara": return kids(el, "m:oMath").map(conv).join(" \\\\ ");
    case "a14:m": return all();
    default: return all();
  }
}

/* LaTeX of an OMML element (a14:m, m:oMathPara or m:oMath) and whether it is a displayed equation */
export function ommlToTex(el) {
  const display = el.name === "m:oMathPara" || (el.name === "a14:m" && !!kid(el, "m:oMathPara"));
  return { tex: conv(el).replace(/\s+/g, " ").replace(/\s*([{}^_])\s*/g, "$1").replace(/\\([a-zA-Z]+)([{}^_])/g, "\\$1$2").trim(), display };
}
