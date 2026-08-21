"""Measures what Gemini's thinking budget costs us in latency, and whether
turning it down costs us correctness.

    python3 scripts/bench-thinking.py

Gemini 3.x reasons before answering, and that reasoning is most of the wall
clock a user waits through. The app passes no thinkingConfig at all, so every
generation gets the model's dynamic default. This asks the only question that
matters: how much faster is it with thinking turned down, and does the hard case
still come out right?

The hard case is `decline-drawing`. A stick figure and the word "ball" must come
back as kind="drawing" with no nodes. Getting that wrong is the regression that
made the feature unusable once already, and it is exactly the judgement that
thinking might be paying for. A config that is fast and gets that wrong is not a
win.

Prompts, schema and fixtures are read from the app source, so this cannot drift
from what ships. Needs /tmp/limn-schema.json, written by a throwaway vitest that
imports geminiDiagramSchema from @/lib/ai/schema.
"""
import json, re, base64, pathlib, subprocess, time, statistics as st

ROOT = pathlib.Path("/Users/alexli/limn")
KEY = re.search(r"^GEMINI_API_KEY=(.*)$", (ROOT / ".env").read_text(), re.M).group(1).strip()
SRC = (ROOT / "apps/web/lib/ai/gemini.ts").read_text()
MODEL = "gemini-3.6-flash"

def extract(name):
    return re.search(rf"const {name} = `(.*?)`;", SRC, re.S).group(1).replace("\\`", "`")

REFINE_SYSTEM, PROMPT_SYSTEM = extract("REFINE_SYSTEM"), extract("PROMPT_SYSTEM")
SCHEMA = json.loads(pathlib.Path("/tmp/limn-schema.json").read_text())

def img(name):
    return base64.b64encode((ROOT / "apps/web/lib/ai/__fixtures__" / name).read_bytes()).decode()

STICK = [{"id":"head","type":"ellipse","x":138,"y":68,"width":104,"height":104},
         {"id":"body","type":"line","x":190,"y":172,"width":0,"height":110},
         {"id":"arm-l","type":"line","x":128,"y":202,"width":62,"height":48},
         {"id":"leg-l","type":"line","x":138,"y":282,"width":52,"height":80},
         {"id":"word","type":"text","x":400,"y":140,"width":108,"height":48,"text":"ball"}]
FLOW = [{"id":"b1","type":"rectangle","x":40,"y":60,"width":200,"height":90},
        {"id":"t1","type":"text","x":70,"y":95,"width":140,"height":24,"text":"collect input","containerId":"b1"},
        {"id":"b2","type":"rectangle","x":400,"y":60,"width":200,"height":90},
        {"id":"t2","type":"text","x":430,"y":95,"width":140,"height":24,"text":"store result","containerId":"b2"},
        {"id":"a1","type":"arrow","x":240,"y":105,"width":160,"height":0},
        {"id":"d1","type":"diamond","x":200,"y":240,"width":200,"height":120},
        {"id":"t3","type":"text","x":240,"y":290,"width":120,"height":24,"text":"valid?","containerId":"d1"}]

def call(system, parts, temp, thinking, attempt=0):
    """One generation, retried through the flaky link this is measured over.

    Measured from China through a proxy, so wall-clock latency is noisy enough
    that a single sample says little and a dropped connection is common. Thought
    tokens come from the API's own usage metadata and are unaffected by any of
    that, which makes them the honest signal for how much reasoning a config
    buys.
    """
    cfg = {"responseMimeType": "application/json", "responseSchema": SCHEMA,
           "temperature": temp, "maxOutputTokens": 16384}
    if thinking is not None:
        cfg["thinkingConfig"] = thinking
    body = {"contents": [{"role": "user", "parts": parts}],
            "systemInstruction": {"parts": [{"text": system}]},
            "generationConfig": cfg}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={KEY}"
    t0 = time.time()
    raw = subprocess.run(["curl", "-s", "-m", "180", url, "-H", "Content-Type: application/json",
                          "--data", json.dumps(body)], capture_output=True, text=True).stdout
    ms = (time.time() - t0) * 1000
    try:
        d = json.loads(raw)
    except Exception:
        if attempt < 3:
            time.sleep(2 + 2 * attempt)
            return call(system, parts, temp, thinking, attempt + 1)
        return {"err": "unparseable", "ms": ms}
    if "error" in d:
        code = d["error"].get("code")
        if code in (429, 500, 503) and attempt < 3:
            time.sleep(3 + 3 * attempt)
            return call(system, parts, temp, thinking, attempt + 1)
        return {"err": f"{code} {d['error'].get('message','')[:70]}", "ms": ms}
    c = d.get("candidates", [{}])[0]
    txt = "".join(p.get("text", "") for p in c.get("content", {}).get("parts", []))
    u = d.get("usageMetadata", {})
    try:
        parsed = json.loads(txt)
    except Exception:
        return {"err": "bad-json", "ms": ms, "finish": c.get("finishReason")}
    return {"ms": ms, "out": u.get("candidatesTokenCount", 0),
            "think": u.get("thoughtsTokenCount", 0), "d": parsed}

TASKS = [
    ("decline-drawing", lambda: (REFINE_SYSTEM,
        [{"inlineData": {"mimeType": "image/png", "data": img("stick-figure-ball.png")}},
         {"text": f"Elements ({len(STICK)}):\n\n{json.dumps(STICK)}\n\nSet layout to \"preserve\".\n\nAuthor's instruction: make it look animated"}], 0.2),
     lambda r: "d" in r and r["d"].get("kind") == "drawing" and not r["d"].get("nodes")),
    ("accept-flowchart", lambda: (REFINE_SYSTEM,
        [{"inlineData": {"mimeType": "image/png", "data": img("flowchart.png")}},
         {"text": f"Elements ({len(FLOW)}):\n\n{json.dumps(FLOW)}\n\nSet layout to \"preserve\"."}], 0.2),
     lambda r: "d" in r and r["d"].get("kind") == "diagram" and len(r["d"].get("nodes", [])) >= 2),
]

# thinkingBudget is rejected by gemini-3.6-flash with 400 "Request contains an
# invalid argument", so the level enum is the only knob this model exposes.
CONFIGS = [
    ("default (as shipped)", None),
    ("level MINIMAL", {"thinkingLevel": "MINIMAL"}),
]

RUNS = int(__import__("os").environ.get("RUNS", "1"))
print(f"model {MODEL}, {RUNS} run(s) per cell\n")
print(f"{'config':<22} {'task':<18} {'ok':>4} {'ms':>7} {'out':>6} {'think':>7}  notes")
print("-" * 84)

table = {}
for label, thinking in CONFIGS:
    for tname, mk, check in TASKS:
        rows = []
        for _ in range(RUNS):
            system, parts, temp = mk()
            rows.append(call(system, parts, temp, thinking))
            time.sleep(1.5)
        good = [r for r in rows if "d" in r]
        ok = sum(1 for r in rows if check(r))
        ms = [r["ms"] for r in good]
        think = [r["think"] for r in good]
        errs = {r["err"] for r in rows if "err" in r}
        table[(label, tname)] = (ok, len(rows), int(st.median(ms)) if ms else 0)
        print(f"{label:<22} {tname:<18} {ok}/{len(rows):<2} "
              f"{int(st.median(ms)) if ms else 0:>7} "
              f"{int(st.median([r['out'] for r in good])) if good else 0:>6} "
              f"{int(st.median(think)) if think else 0:>7}  {','.join(errs) if errs else ''}")

base = st.median([v[2] for k, v in table.items() if k[0] == CONFIGS[0][0] and v[2]] or [0])
print(f"\nbaseline median across tasks: {int(base)} ms")
for label, _ in CONFIGS[1:]:
    got = [v[2] for k, v in table.items() if k[0] == label and v[2]]
    correct = all(v[0] == v[1] for k, v in table.items() if k[0] == label)
    if got:
        m = st.median(got)
        delta = (1 - m / base) * 100 if base else 0
        print(f"  {label:<22} {int(m):>6} ms  ({delta:+.0f}%)  correctness {'kept' if correct else 'LOST'}")
