"""Benchmarks Gemini models against the app's real prompts, schema and fixtures.

    export GEMINI_API_KEY=...            # or rely on ../.env
    python3 scripts/bench-gemini.py

Exists because picking a model by reading version numbers is guesswork, and the
one time it mattered the guess was wrong: gemini-3.5-flash was chosen off a
single sample and gemini-3.6-flash turned out to be strictly better on
correctness. Model availability also changes without notice, gemini-2.5-flash
went from working to withdrawn for new keys mid-project.

Scores three things the app actually depends on:
  decline-drawing    a stick figure must NOT be turned into boxes
  accept-flowchart   a real flowchart must still be recognised
  prompt-pipeline    text to a diagram with a sane number of nodes and edges

Prompts and response schema are read from the app source rather than copied, so
this cannot drift from what ships. The schema comes from /tmp/limn-schema.json,
written by a one-line vitest that imports the real module:

    import { geminiDiagramSchema } from "@/lib/ai/schema";

Free-tier quota is tight; a full run can exhaust it and start returning 429.
"""
import json, re, base64, pathlib, subprocess, time, statistics as st

ROOT = pathlib.Path("/Users/alexli/limn")
KEY = re.search(r"^GEMINI_API_KEY=(.*)$", (ROOT/".env").read_text(), re.M).group(1).strip()
SRC = (ROOT/"apps/web/lib/ai/gemini.ts").read_text()

def extract(name):
    m = re.search(rf"const {name} = `(.*?)`;", SRC, re.S)
    return m.group(1).replace("\\`", "`")

REFINE_SYSTEM, PROMPT_SYSTEM = extract("REFINE_SYSTEM"), extract("PROMPT_SYSTEM")

SCHEMA_PATH = pathlib.Path("/tmp/limn-schema.json")
if not SCHEMA_PATH.exists():
    raise SystemExit(
        "Missing /tmp/limn-schema.json. Generate it with a throwaway vitest that "
        "imports geminiDiagramSchema from @/lib/ai/schema and writes it out."
    )
SCHEMA = json.loads(SCHEMA_PATH.read_text())

def img(name):
    return base64.b64encode((ROOT/"apps/web/lib/ai/__fixtures__"/name).read_bytes()).decode()

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

def call(model, system, parts, temp):
    b = {"contents":[{"role":"user","parts":parts}],
         "systemInstruction":{"parts":[{"text":system}]},
         "generationConfig":{"responseMimeType":"application/json","responseSchema":SCHEMA,
                             "temperature":temp,"maxOutputTokens":16384}}
    url=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={KEY}"
    t0=time.time()
    raw=subprocess.run(["curl","-s","-m","120",url,"-H","Content-Type: application/json",
                        "--data",json.dumps(b)],capture_output=True,text=True).stdout
    ms=(time.time()-t0)*1000
    try: d=json.loads(raw)
    except Exception: return {"err":"unparseable","ms":ms}
    if "error" in d: return {"err":f"{d['error']['code']}","ms":ms}
    c=d.get("candidates",[{}])[0]
    txt="".join(p.get("text","") for p in c.get("content",{}).get("parts",[]))
    u=d.get("usageMetadata",{})
    try: parsed=json.loads(txt)
    except Exception: return {"err":"bad-json","ms":ms,"finish":c.get("finishReason")}
    return {"ms":ms,"out":u.get("candidatesTokenCount",0),"think":u.get("thoughtsTokenCount",0),
            "d":parsed,"finish":c.get("finishReason")}

TASKS = [
 ("decline-drawing", lambda: (REFINE_SYSTEM, [{"inlineData":{"mimeType":"image/png","data":img("stick-figure-ball.png")}},
    {"text":f"Elements ({len(STICK)}):\n\n{json.dumps(STICK)}\n\nSet layout to \"preserve\".\n\nAuthor's instruction: make it look animated"}], 0.2)),
 ("accept-flowchart", lambda: (REFINE_SYSTEM, [{"inlineData":{"mimeType":"image/png","data":img("flowchart.png")}},
    {"text":f"Elements ({len(FLOW)}):\n\n{json.dumps(FLOW)}\n\nSet layout to \"preserve\"."}], 0.2)),
 ("prompt-pipeline", lambda: (PROMPT_SYSTEM, [{"text":"A CI/CD pipeline: commit, build, unit tests, if tests fail notify the dev, otherwise deploy to staging, smoke tests, canary at 5%, then full rollout, with a rollback path from canary."}], 0.4)),
]
MODELS=["gemini-3.5-flash","gemini-3.6-flash","gemini-3.7-flash","gemini-3.1-flash-lite"]
RUNS=3
res={m:{t:[] for t,_ in TASKS} for m in MODELS}

for run in range(RUNS):
    for m in MODELS:
        for tname, mk in TASKS:
            system, parts, temp = mk()
            r = call(m, system, parts, temp)
            res[m][tname].append(r)
            time.sleep(1.2)
    print(f"  round {run+1}/{RUNS} done", flush=True)

def ok_decline(r): return "d" in r and r["d"].get("kind")=="drawing" and not r["d"].get("nodes")
def ok_accept(r):  return "d" in r and r["d"].get("kind")=="diagram" and len(r["d"].get("nodes",[]))>=2
def ok_prompt(r):  return "d" in r and len(r["d"].get("nodes",[]))>=4 and len(r["d"].get("edges",[]))>=3

CHECK={"decline-drawing":ok_decline,"accept-flowchart":ok_accept,"prompt-pipeline":ok_prompt}
print(f"\n{'model':<24} {'task':<18} {'correct':>8} {'p50 ms':>8} {'out':>6} {'think':>7} {'errors'}")
print("-"*82)
summary={}
for m in MODELS:
    tot_ok=tot=0; lat=[]
    for tname,_ in TASKS:
        rs=res[m][tname]
        good=[r for r in rs if "d" in r]
        correct=sum(1 for r in rs if CHECK[tname](r))
        errs=[r.get("err") for r in rs if "err" in r]
        ms=[r["ms"] for r in good]
        tot_ok+=correct; tot+=len(rs); lat+=ms
        print(f"{m:<24} {tname:<18} {correct}/{len(rs):>6} "
              f"{int(st.median(ms)) if ms else 0:>8} "
              f"{int(st.mean([r['out'] for r in good])) if good else 0:>6} "
              f"{int(st.mean([r['think'] for r in good])) if good else 0:>7} "
              f"{','.join(errs) if errs else '-'}")
    summary[m]=(tot_ok,tot,int(st.median(lat)) if lat else 0)
print("-"*82)
for m,(o,t,l) in summary.items():
    print(f"{m:<24} correct {o}/{t}  median latency {l}ms")
