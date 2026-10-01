"""Regenerates the example figure, the demo audio and the waveform images used by index.html.
Needs only numpy. Run from this folder:  python3 make_figures.py

Everything here is synthetic placeholder material: replace it with your own data and recordings.
"""
import wave
import numpy as np

OCEAN, LAGOON, DEEP, SLATE, GRID = "#0B63B5", "#19B3C9", "#0A2A4F", "#5B6B7F", "#DCE6EF"
FONT = "Inter, 'Segoe UI', Arial, sans-serif"


# ---- Figure: transmission loss over range (spherical spreading + absorption) -------------
def transmission_loss_svg(path):
    W, H = 640, 430
    L, R, T, B = 78, 24, 22, 70                      # plot margins
    r_km = np.logspace(-1, 2, 300)                   # 0.1 ... 100 km
    curves = [(1, 0.07, DEEP, "1 kHz"), (10, 1.0, OCEAN, "10 kHz"), (50, 14.0, LAGOON, "50 kHz")]
    y0, y1 = 40, 160                                 # dB, top to bottom of the axis

    def px(r):  return L + (np.log10(r) + 1) / 3 * (W - L - R)
    def py(tl): return T + (tl - y0) / (y1 - y0) * (H - T - B)

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="{FONT}">']
    for tl in range(40, 161, 20):                    # grid and y labels
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{py(tl):.1f}" y2="{py(tl):.1f}" stroke="{GRID}"/>')
        out.append(f'<text x="{L - 10}" y="{py(tl) + 5:.1f}" font-size="15" fill="{SLATE}" text-anchor="end">{tl}</text>')
    for r, lab in [(0.1, "0.1"), (1, "1"), (10, "10"), (100, "100")]:
        out.append(f'<line x1="{px(r):.1f}" x2="{px(r):.1f}" y1="{T}" y2="{H - B}" stroke="{GRID}"/>')
        out.append(f'<text x="{px(r):.1f}" y="{H - B + 24}" font-size="15" fill="{SLATE}" text-anchor="middle">{lab}</text>')
    out.append(f'<text x="{(L + W - R) / 2}" y="{H - 18}" font-size="16" fill="{SLATE}" text-anchor="middle">Range (km)</text>')
    out.append(f'<text transform="translate(20 {(T + H - B) / 2}) rotate(-90)" font-size="16" fill="{SLATE}" '
               f'text-anchor="middle">Transmission loss (dB)</text>')
    for f, alpha, color, lab in curves:              # TL = 20 log10(r/1 m) + alpha * r
        tl = 20 * np.log10(r_km * 1000) + alpha * r_km
        keep = tl <= y1
        pts = " ".join(f"{px(a):.1f},{py(b):.1f}" for a, b in zip(r_km[keep], tl[keep]))
        out.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="3.5" stroke-linecap="round"/>')
    for i, (_, _, color, lab) in enumerate(curves):  # legend, in the empty lower-left corner
        y = H - B - 78 + i * 26
        out.append(f'<line x1="{L + 18}" x2="{L + 44}" y1="{y}" y2="{y}" stroke="{color}" stroke-width="4" stroke-linecap="round"/>')
        out.append(f'<text x="{L + 52}" y="{y + 5}" font-size="15" fill="{DEEP}">{lab}</text>')
    out.append(f'<rect x="{L}" y="{T}" width="{W - L - R}" height="{H - T - B}" fill="none" stroke="{SLATE}" stroke-width="1"/>')
    out.append("</svg>")
    open(path, "w").write("\n".join(out))


# ---- Audio: a synthetic "whale call" in ship noise, before and after processing -----------
SR, DUR = 16000, 5.0


def make_audio():
    t = np.arange(int(SR * DUR)) / SR
    rng = np.random.default_rng(7)
    call = np.zeros_like(t)
    for start in (0.6, 2.7):                         # two upsweeping calls with harmonics
        tt = t - start
        on = (tt >= 0) & (tt < 1.6)
        f = 220 + 160 * np.sin(np.pi * np.clip(tt, 0, 1.6) / 1.6) + 90 * np.clip(tt, 0, 1.6)
        phase = 2 * np.pi * np.cumsum(f) / SR
        env = np.sin(np.pi * np.clip(tt, 0, 1.6) / 1.6) ** 2 * on
        call += env * (np.sin(phase) + 0.35 * np.sin(2 * phase) + 0.15 * np.sin(3 * phase))
    brown = np.cumsum(rng.standard_normal(t.size))
    brown -= np.convolve(brown, np.ones(400) / 400, mode="same")           # remove drift
    brown /= np.max(np.abs(brown))
    ship = sum(np.sin(2 * np.pi * 62 * k * t + k) / k for k in range(1, 6))  # engine tonals
    swell = 0.7 + 0.3 * np.sin(2 * np.pi * 0.25 * t)
    noisy = call + 1.1 * swell * brown + 0.35 * ship + 0.08 * rng.standard_normal(t.size)
    clean = call + 0.12 * brown + 0.02 * rng.standard_normal(t.size)
    return {"sample_a": noisy, "sample_b": clean}


def write_wav(path, x):
    x = x / np.max(np.abs(x)) * 0.8
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def write_wave_svg(path, x, color):
    n, W, H = 220, 1000, 120
    peaks = np.array([b.max() for b in np.array_split(np.abs(x) / np.max(np.abs(x)), n)])
    bars = []
    for i, p in enumerate(peaks):
        h = max(3, p * (H - 10))
        bars.append(f'<rect x="{i * W / n + 1.2:.1f}" y="{(H - h) / 2:.1f}" width="{W / n - 2.4:.1f}" '
                    f'height="{h:.1f}" rx="2"/>')
    open(path, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
                          f'preserveAspectRatio="none"><g fill="{color}">{"".join(bars)}</g></svg>')


if __name__ == "__main__":
    transmission_loss_svg("transmission_loss.svg")
    audio = make_audio()
    write_wav("sample_a.wav", audio["sample_a"]); write_wave_svg("wave_a.svg", audio["sample_a"], SLATE)
    write_wav("sample_b.wav", audio["sample_b"]); write_wave_svg("wave_b.svg", audio["sample_b"], OCEAN)
    print("done")
