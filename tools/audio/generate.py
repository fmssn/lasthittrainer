"""Render every prompt in prompts.json on a running ComfyUI with Stable Audio 3 Medium.

    python generate.py [names...]

Each sound renders as one batch from seed 1000; batch item i is take #i, which
is what keepers.json records. The files land in ComfyUI's output folder under
$OUTDIR (default `lht`), as FLAC, for process.py to rank and clean.

Medium, not Medium Base: Base is the checkpoint before post-training, and it
follows a one-shot prompt badly — a single coin came back as a dozen clicks,
a single knock as four. Medium is distilled, so its guidance is baked in: 8
steps at CFG 1, and at CFG 1 a negative prompt does nothing.
"""
import json, os, pathlib, sys, time, urllib.request

HERE = pathlib.Path(__file__).parent
URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
OUTDIR = os.environ.get("OUTDIR", "lht")
SEED = 1000


def graph(s):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "stable_audio_3_medium.safetensors"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5gemma_b_b_ul2.safetensors", "type": "stable_audio", "device": "default"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": s["prompt"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
        # SA3 reads the clip length from the latent itself, so the request length is the only duration control.
        "5": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": s["seconds"], "batch_size": s["batch"]}},
        "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0],
              "seed": SEED, "steps": 8, "cfg": 1.0, "sampler_name": "lcm", "scheduler": "simple", "denoise": 1.0}},
        "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveAudioAdvanced", "inputs": {"audio": ["7", 0], "filename_prefix": f"{OUTDIR}/{s['name']}", "format": "flac"}},
    }


def post(path, body):
    r = urllib.request.Request(URL + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))


prompts = json.load(open(HERE / "prompts.json"))
want = set(sys.argv[1:])
jobs = {post("/prompt", {"prompt": graph(s)})["prompt_id"]: s["name"] for s in prompts if not want or s["name"] in want}
t = time.time()
while jobs:
    time.sleep(2)
    for pid in list(jobs):
        h = json.load(urllib.request.urlopen(f"{URL}/history/{pid}")).get(pid)
        if not h:
            continue
        st = h["status"]
        n = sum(len(o.get("audio", [])) for o in h["outputs"].values())
        print(f"{jobs.pop(pid):18s} {st['status_str']:8s} {n:3d} takes  t={time.time() - t:.0f}s", flush=True)
        if st["status_str"] != "success":
            print(json.dumps(st["messages"])[-1500:])
