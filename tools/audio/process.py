"""Rank the takes of every sound and clean up the best ones, following docs/sounds.md.

    SRC=<ComfyUI output>/lht OUT=candidates python process.py [names...]

Needs numpy, scipy and PyAV, which a ComfyUI venv already has. Writes the best
$KEEP takes of each sound as <name>_<rank>.wav plus candidates.json, which
records each take's batch index for keepers.json.

Ranking is only a first cut a machine can make: one clear onset, a sharp attack
where the sound needs one, a tail that ends near its target length, no clipping.
It cannot tell a coin from a spoon; the ear picks among the survivors.
"""
import glob, json, os, sys, numpy as np, av, wave
from scipy import signal
SR = 44100
OUT = os.path.expanduser(os.environ.get("OUT", "candidates")); os.makedirs(OUT, exist_ok=True)
SRC = os.path.expanduser(os.environ["SRC"])
NAMES = sys.argv[1:]  # prompt variants such as last_hit_gold__palm; empty means the whole set
# name: (target length s, needs sharp attack, keep lows)
SPEC = {
 "last_hit_gold": (0.5, True, False), "deny": (0.4, True, False), "sword_swing": (0.3, False, False),
 "sword_hit": (0.4, True, False), "bow_release": (0.4, True, False), "frost_arrow_hit": (0.4, True, False),
 "melee_creep_hit": (0.3, True, False), "ranged_creep_cast": (0.4, True, False), "ranged_creep_hit": (0.3, True, False),
 "creep_death": (0.8, False, True), "siege_launch": (0.8, True, True), "siege_hit": (0.8, True, True),
 "tower_attack": (0.6, True, True), "tower_hit": (0.5, True, True), "hero_death": (1.5, False, True),
 "horn": (3.0, False, True), "bow_draw": (0.45, False, False), "ui_click": (0.1, True, False), "run_end": (2.0, False, True),
}
KEEP = int(os.environ.get("KEEP", 4))

def load(f, mono=True):
    c = av.open(f); st = c.streams.audio[0]
    rs = av.AudioResampler(format="fltp", layout="mono" if mono else "stereo", rate=SR)
    x = np.concatenate([r.to_ndarray() for fr in c.decode(st) for r in rs.resample(fr)], axis=1).astype(np.float64)
    return x[0] if mono else x

def env_db(x, win=0.005):
    n = int(SR * win)
    fr = x[: len(x) // n * n].reshape(-1, n)
    return 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9), win

def analyse(x, L, sharp):
    e, w = env_db(x)
    pk = e.max(); ip = int(e.argmax())
    on = int(np.argmax(e > pk - 30))                     # onset: first frame within 30 dB of the peak
    attack = (ip - on) * w
    # extra events: after the first burst falls 20 dB below the peak, anything climbing back within 10 dB
    below = np.where(e[ip:] < pk - 20)[0]
    extra = 0
    if len(below):
        rest = e[ip + below[0]:]
        extra = int(np.sum(np.diff((rest > pk - 10).astype(int)) == 1))
    quiet = np.where(e[ip:] < pk - 45)[0]
    end = (ip + (quiet[0] if len(quiet) else len(e) - ip)) * w
    length = end - on * w
    clip = float(np.mean(np.abs(x) > 0.995))
    score = 0.0
    score -= 3.0 * extra
    if sharp: score -= 20 * max(0.0, attack - 0.012)      # every 10 ms of soft attack past 12 ms costs 0.2
    score -= 1.5 * max(0.0, length / L - 1.6)             # rings far past its slot
    score -= 1.0 * max(0.0, 0.5 - length / L)             # far shorter than asked
    score -= 200 * clip
    score -= 0.02 * max(0.0, on * w - 0.5)                # a very late onset hints at a pre-roll of something else
    return dict(onset=on * w, attack=attack, extra=extra, length=length, clip=clip, peak_db=float(pk), score=score)

def hpf(x, hz=90):
    # Causal on purpose: a zero-phase filter pre-rings ahead of the transient, which is the one place it must not.
    return signal.sosfilt(signal.butter(2, hz, "highpass", fs=SR, output="sos"), x)

def clean_to_peak(x, L):
    # A draw has to culminate where it hands over to the release: keep the L seconds that END at the loudest moment.
    e, w = env_db(x, 0.02)
    end = int((int(e.argmax()) + 1) * w * SR); start = max(0, end - int(L * SR))
    y = hpf(x[start:end].copy())
    fi, fo = int(SR * 0.06), int(SR * 0.012)
    y[:fi] *= np.linspace(0, 1, fi); y[-fo:] *= np.linspace(1, 0, fo)
    return y / (np.abs(y).max() + 1e-12) * 10 ** (-1 / 20)

def clean(x, a, L, keep_lows):
    s = max(0, int((a["onset"] - 0.002) * SR))           # 2 ms before the onset so the transient is intact
    natural = a["length"] + 0.002
    dur = min(natural, L) if natural > L * 0.5 else natural
    y = x[s: s + int(dur * SR)].copy()
    if not keep_lows: y = hpf(y)
    rings_past = natural > L
    nf = int(SR * (max(0.25 * dur, 0.010) if rings_past else 0.008))
    y[-nf:] *= np.cos(np.linspace(0, np.pi / 2, nf)) ** 2
    y[: int(SR * 0.001)] *= np.linspace(0, 1, int(SR * 0.001))  # 1 ms fade-in, just enough to avoid a click
    return y / (np.abs(y).max() + 1e-12) * 10 ** (-1 / 20)

def write_wav(path, y, sr=SR):
    y = np.atleast_2d(y)
    pcm = (np.clip(y, -1, 1) * 32767).round().astype("<i2").T.copy()
    with wave.open(path, "wb") as w:
        w.setnchannels(y.shape[0]); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())

def k_weight(x, sr):
    # ITU-R BS.1770 pre-filter: high shelf (+4 dB, ~1.5 kHz) then RLB high-pass (~38 Hz), designed at this rate.
    import math
    G, Q, fc = 3.999843853973347, 0.7071752369554196, 1681.974450955533
    K = math.tan(math.pi * fc / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    Q2, fc2 = 0.5003270373238773, 38.13547087602444
    K = math.tan(math.pi * fc2 / sr); a0 = 1 + K / Q2 + K * K
    a2 = [1, 2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0]
    return signal.lfilter([1, -2, 1], a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)

def lufs(x, sr):
    y = k_weight(np.atleast_2d(x), sr)
    n = int(0.4 * sr); h = int(0.1 * sr)
    blocks = np.array([(y[:, i:i + n] ** 2).mean(1).sum() for i in range(0, y.shape[1] - n, h)])
    l = -0.691 + 10 * np.log10(blocks + 1e-12)
    g = blocks[l > -70]
    rel = -0.691 + 10 * np.log10(g.mean()) - 10
    g = blocks[(l > -70) & (l > rel)]
    return -0.691 + 10 * np.log10(g.mean())

meta = {}
for name in NAMES or list(SPEC):
    L, sharp, keep_lows = SPEC[name.split("__")[0]]
    takes = []
    for f in sorted(glob.glob(f"{SRC}/{name}_*.flac")):
        x = load(f); a = analyse(x, L, sharp); a["file"] = os.path.basename(f)
        a["batch_index"] = int(a["file"].rsplit("_", 1)[1].split(".")[0]) - 1
        takes.append((a, x))
    takes.sort(key=lambda t: -t[0]["score"])
    meta[name] = []
    for k, (a, x) in enumerate(takes[:KEEP], 1):
        y = clean_to_peak(x, L) if name.startswith("bow_draw") else clean(x, a, L, keep_lows)
        write_wav(f"{OUT}/{name}_{k}.wav", y)
        meta[name].append({kk: (round(v, 4) if isinstance(v, float) else v) for kk, v in a.items()})
    print(f"{name:18s} " + "  ".join(f"#{t[0]['batch_index']:02d} s={t[0]['score']:+.2f} ev={t[0]['extra']} atk={t[0]['attack']*1000:3.0f}ms len={t[0]['length']:.2f}" for t in takes[:KEEP]))

if NAMES:
    json.dump(meta, open(f"{OUT}/candidates.json", "w"), indent=1); sys.exit()
# Ambience: the steadiest takes win. Cut 45 s from the middle, and fold 2 s of what follows back over the start so the loop point is seamless.
amb = []
for f in sorted(glob.glob(f"{SRC}/lane_ambience_*.flac")):
    x = load(f, mono=False); e, _ = env_db(x.mean(0), 0.4)
    mid = e[int(7.5 / 0.4): int(52.5 / 0.4)]
    amb.append((float(np.std(mid) + max(0, mid.max() - np.median(mid) - 8)), f, x))
amb.sort(key=lambda t: t[0])
meta["lane_ambience"] = []
for k, (steadiness, f, x) in enumerate(amb[:3], 1):
    a, b, xf = int(7.5 * SR), int(52.5 * SR), int(2 * SR)
    seg = x[:, a:b].copy()
    fade = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    seg[:, :xf] = seg[:, :xf] * fade + x[:, b:b + xf] * (1 - fade)
    y = signal.resample_poly(seg, 1, 2, axis=1); sr2 = SR // 2
    y *= 10 ** ((-23 - lufs(y, sr2)) / 20)
    if np.abs(y).max() > 0.89: y *= 0.89 / np.abs(y).max()
    write_wav(f"{OUT}/lane_ambience_{k}.wav", y, sr2)
    meta["lane_ambience"].append({"file": os.path.basename(f), "batch_index": int(f.rsplit("_", 1)[1].split(".")[0]) - 1, "unsteadiness": round(steadiness, 2), "lufs": round(lufs(y, sr2), 1)})
    print(f"lane_ambience      {os.path.basename(f)} unsteadiness={steadiness:.2f} -> {lufs(y, sr2):.1f} LUFS")
json.dump(meta, open(f"{OUT}/candidates.json", "w"), indent=1)
