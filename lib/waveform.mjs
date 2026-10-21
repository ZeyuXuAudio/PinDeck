/* Waveform SVG for an audio file, as the editor makes for attached audio (bars, viewBox 1000 x 120):
   WAV is read directly; other formats are converted to WAV first, with afconvert on macOS or ffmpeg on
   Linux, when available. */

import { execFile } from "node:child_process";
import { findExecutable } from "./capabilities.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Samples of a PCM or float WAV file as one array per channel (null if the format is not supported,
   or the file is damaged) */
function readWav(buf) {
  try { return wavOf(buf); } catch { return null; }
}
function wavOf(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), bits: buf.readUInt16LE(p + 22) };
    if (id === "data") data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || !fmt.channels || !fmt.bits) return null;
  const format = fmt.format === 0xfffe ? (fmt.bits === 32 && data.length ? 3 : 1) : fmt.format;   // extensible: guess from the bits
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.channels));
  const read = format === 3 && fmt.bits === 32 ? (o) => data.readFloatLE(o)
    : format === 1 && fmt.bits === 16 ? (o) => data.readInt16LE(o) / 32768
    : format === 1 && fmt.bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608
    : format === 1 && fmt.bits === 32 ? (o) => data.readInt32LE(o) / 2147483648
    : format === 1 && fmt.bits === 8 ? (o) => (data[o] - 128) / 128 : null;
  if (!read) return null;
  return { frames, channels: fmt.channels, sample: (i, c) => read((i * fmt.channels + c) * bytes) };
}

function svgOf(wav) {
  const n = 220, W = 1000, H = 120, len = wav.frames;
  const peaks = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor((i * len) / n), b = Math.floor(((i + 1) * len) / n);
    for (let c = 0; c < wav.channels; c++) for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(wav.sample(j, c)));
    peaks.push(m);
  }
  const top = Math.max(...peaks) || 1;
  const bars = peaks.map((p, i) => {
    const h = Math.max(3, (p / top) * (H - 10));
    return `<rect x="${(i * W / n + 1.2).toFixed(1)}" y="${((H - h) / 2).toFixed(1)}" width="${(W / n - 2.4).toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g fill="#6B7785">${bars}</g></svg>`;
}

/* Returns the SVG text, or null if the audio cannot be read */
export async function waveformSvg(data, ext) {
  let wav = /^wav(e)?$/i.test(ext) ? readWav(data) : null;
  // other formats: decoded to 16-bit WAV by afconvert (macOS) or ffmpeg (Linux, when installed)
  const ffmpeg = process.platform !== "darwin" && findExecutable("ffmpeg").path;
  if (!wav && (process.platform === "darwin" || ffmpeg)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pindeck-wave-"));
    try {
      const src = path.join(dir, `in.${ext || "audio"}`), out = path.join(dir, "out.wav");
      fs.writeFileSync(src, data);
      const [cmd, args] = ffmpeg ? [ffmpeg, ["-v", "error", "-y", "-i", src, "-f", "wav", "-acodec", "pcm_s16le", out]]
        : ["afconvert", ["-f", "WAVE", "-d", "LEI16", src, out]];
      await new Promise((resolve, reject) => execFile(cmd, args, { timeout: 60000 },
        (err) => (err ? reject(err) : resolve())));
      wav = readWav(fs.readFileSync(out));
    } catch { wav = null; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  try { return wav && wav.frames ? svgOf(wav) : null; } catch { return null; }
}
