# Setup, from scratch

Nine phases. Phases 1–5 get it running on your machine; 6–9 put it on the
internet. You can stop after 5 and still have a working app.

Each phase ends with something you can check, so a mistake surfaces where it was
made rather than three steps later.

---

## Phase 0. Tools

You already have Node 22 and pnpm 11. You need two more.

```bash
brew install supabase/tap/supabase   # database migrations
python3.11 --version                 # should print 3.11.x
```

**On Python:** use **3.11 or 3.12**, not 3.13+. `opencv-contrib-python-headless`
4.10 publishes wheels up to cp312; above that, pip falls back to compiling
OpenCV from source, which takes forever and usually fails. You have 3.11, which
is what the local venv uses. Render is pinned to 3.12 in `render.yaml`.

Accounts you'll need, all free: [Supabase](https://supabase.com),
[Google AI Studio](https://aistudio.google.com), [Render](https://render.com),
[Vercel](https://vercel.com), [UptimeRobot](https://uptimerobot.com).

---

## Phase 1. The code runs before anything is configured

```bash
cd ~/limn
pnpm install
pnpm build:packages
```

Prove the parts that don't need credentials actually work:

```bash
pnpm --filter @limn/protocol test    # 20 tests, convergence properties
pnpm --filter @limn/shapes test      # 5 tests, prints the 95.8% benchmark
```

> **Check:** both report `fail 0`, and the shapes run prints
> `recognition: 95.8% over 600 strokes`.

If this fails, stop here. Nothing downstream will work and the cause is local.

---

## Phase 2. Supabase

### 2a. Create the project

[database.new](https://database.new) → name it `limn` → pick the region nearest
you → **save the database password somewhere**, you need it in a moment.

Wait for provisioning (~2 minutes).

### 2b. Push the schema

```bash
cd ~/limn
supabase init          # creates supabase/config.toml next to the migrations
supabase login         # opens a browser
supabase link --project-ref <your-ref>
supabase db push
```

Your project ref is in the dashboard URL:
`supabase.com/dashboard/project/`**`abcdefghijklmnop`**. `db push` will ask for
the database password from 2a.

**If `db push` fails with `Connection terminated unexpectedly`,** use the pooler
instead:

```bash
./scripts/db.sh push
```

`db push` connects to `db.<ref>.supabase.co`, which resolves only over IPv6.
IPv4 on that host is a paid add-on. Any network that can't carry IPv6 to it
fails with a message that reads like an auth or provisioning problem and is
neither. It is especially likely behind a fake-IP proxy (Clash, Shadowrocket,
sing-box), where every hostname resolves to a synthetic `198.18.x.x` address and
only proxied protocols reach anywhere. A plain port check still looks healthy,
because TCP completes against the local proxy.

`scripts/db.sh` routes the same command through the connection pooler, which is
reachable over IPv4. `supabase link` already cached the pooler URL; the script
just supplies the password. Use it for every later migration too.

It should apply five migrations in order:

```
20260814000100_schema.sql     tables, triggers, revision pruning
20260814000200_functions.sql  access helpers, snapshot compare-and-swap
20260814000300_rls.sql        row-level security + Realtime authorization
20260814000400_storage.sql    buckets for images and thumbnails
20260814000500_grants.sql     explicit table privileges
```

### 2c. Turn on anonymous sign-ins

Dashboard → **Authentication → Sign In / Providers → Anonymous sign-ins →
enable.**

This is not optional. It is the entire onboarding path. Every "Start drawing"
button calls `signInAnonymously()`. Without it the landing page throws.

### 2d. Grab your keys

Dashboard → **Project Settings → API**:

- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
- **anon / public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Ignore the `service_role` key. Nothing in this project uses it, and it bypasses
every security policy you just installed.

> **Check:** Dashboard → Table Editor shows `boards`, `board_snapshots`,
> `profiles`, `board_collaborators`, `ai_generations`, `vision_jobs`,
> `board_revisions`, `stats_cache`.

You can also verify the security properties locally, against throwaway Postgres,
without touching your project:

```bash
PGUSER=$(whoami) ./supabase/tests/run.sh    # expect: PASS
```

---

## Phase 3. Gemini key

[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API
key** → copy it. Free tier is fine; it is rate-limited per minute, not per month.

---

## Phase 4. Fill in the environment

Two files, same contents. The root one is for the load test; the app one is for
Next.js.

```bash
cd ~/limn
cp .env.example .env
```

Edit `.env` and set:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your anon key>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
GEMINI_API_KEY=<your gemini key>
VISION_SERVICE_URL=http://localhost:8000
VISION_API_KEY=                     # leave blank locally
```

Then copy it across:

```bash
cp .env apps/web/.env.local
```

`apps/web/.env.local` currently holds build-time placeholders from development,
so overwriting it is the right move. Both files are gitignored.

> Leaving `VISION_API_KEY` blank locally is deliberate: the vision service skips
> its auth check when the variable is unset, and logs a warning saying so. In
> production it is required.

---

## Phase 5. Run it locally

### 5a. Vision service

```bash
cd ~/limn/apps/vision
python3.11 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt   # ~1 min, OpenCV is large
```

Verify OpenCV came through with the contrib modules:

```bash
./.venv/bin/python -c "import cv2; print(cv2.__version__, hasattr(cv2,'ximgproc'))"
# 4.10.0 True
```

`ximgproc` must be `True`. It provides the Zhang-Suen thinning the photo pipeline
depends on. If it is `False`, you installed `opencv-python` instead of
`opencv-contrib-python`.

Run its tests:

```bash
./.venv/bin/python -m pytest tests -q    # 15 passed
```

### 5b. Everything at once

```bash
cd ~/limn
pnpm dev
```

That builds the workspace packages, then starts the Next.js app on **:3000** and
the vision service on **:8000**.

> **Check:** `curl localhost:8000/health` returns
> `{"status":"ok","service":"limn-vision","opencv":"4.10.0",...}`

### 5c. Smoke test, in order

Open http://localhost:3000 and work down this list. Each step exercises a
different subsystem, so a failure tells you which one.

1. **Click "Start drawing."** → lands on a board.
   *Exercises: anonymous auth, `create_board` RPC, RLS.*
2. **Draw a rough rectangle freehand.** → snaps to a clean rectangle when you
   lift the pen. The header shows `Snap on 1`.
   *Exercises: the client recogniser. No network involved.*
3. **Draw a deliberate squiggle.** → stays a squiggle.
   *Exercises: the recogniser declining, which matters as much as accepting.*
4. **Ctrl+Z after a snap.** → your original wobbly stroke returns.
5. **Copy the share link, open it in a private window.** → two cursors, and
   drawing in one window appears in the other.
   *Exercises: Realtime broadcast, presence, the merge.*
6. **Wait ~5 seconds, reload.** → your drawing is still there, header shows a
   bumped `v` number.
   *Exercises: writer election and the snapshot compare-and-swap.*
7. **Draw a few boxes and arrows, then Beautify → "Keep my layout."**
   *Exercises: Gemini, constrained decoding, the compiler.*
8. **Beautify → "From photo"**, upload any photo of a whiteboard or a
   pen-and-paper sketch.
   *Exercises: the OpenCV pipeline end to end.*

If step 5 fails with a policy error, the `realtime.messages` policies from
migration `...000300_rls.sql` did not apply. Re-run `./scripts/db.sh push`.

**You now have a fully working app.** Phases 6–9 are deployment.

---

## Phase 6. Render (the OpenCV service)

Order matters from here: Render gives you a key that Vercel needs.

1. Push your repo if you haven't: `git push origin main`
2. Render dashboard → **New → Blueprint** → select the `limn` repo.
   It reads [`render.yaml`](../render.yaml) and configures everything.
3. Set the one variable it can't infer:
   - `ALLOWED_ORIGINS` → leave as `http://localhost:3000` for now. You'll add
     the Vercel origin in Phase 9.
4. Deploy. First build takes ~3–5 minutes (OpenCV is a big wheel).
5. **Copy the generated `VISION_API_KEY`** from the service's Environment tab.

> **Check:** `curl https://<your-service>.onrender.com/health` returns `ok`.

---

## Phase 7. Vercel (the app)

1. Vercel → **Add New → Project** → import the `limn` repo.
2. **Set Root Directory to `apps/web`.** This is the step people miss. Without
   it, Vercel builds the monorepo root and finds no Next.js app.
3. Add environment variables (Production *and* Preview):

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | from Phase 2d |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Phase 2d |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-app>.vercel.app` |
   | `GEMINI_API_KEY` | from Phase 3 |
   | `GEMINI_MODEL` | `gemini-3.6-flash` |
   | `GEMINI_MODEL_PRO` | `gemini-pro-latest` |
   | `VISION_SERVICE_URL` | your Render URL, **no trailing slash** |
   | `VISION_API_KEY` | the key Render generated in Phase 6 |

4. Deploy.

`NEXT_PUBLIC_SITE_URL` has to be right. Every "Share" button builds its
link from it, so a wrong value produces links pointing at the wrong host.

> **Check:** the landing page loads and shows live counters from your database.

---

## Phase 8. Close the CORS loop

Go back to **Render → your service → Environment** and set:

```
ALLOWED_ORIGINS=https://<your-app>.vercel.app,http://localhost:3000
```

Save (the service restarts automatically).

This is the easiest step to forget. Skip it and photo vectorisation fails in
production with a browser CORS error that looks like the service being down.

> **Check:** on the deployed site, Beautify → From photo works.

---

## Phase 9. UptimeRobot keepalive

A Render free instance sleeps after 15 minutes idle and takes ~50 seconds to
wake. Fine for a cron job, unacceptable for someone who just tapped "trace my
photo."

UptimeRobot → **New monitor**:

| Field | Value |
|---|---|
| Type | HTTP(s) |
| Friendly name | limn-vision |
| URL | `https://<your-service>.onrender.com/health` |
| Interval | 5 minutes |

Five minutes is the shortest free interval and comfortably inside the 15-minute
window. `/health` is deliberately the only unauthenticated route on the service,
so this works without handing UptimeRobot a secret.

> **Check:** UptimeRobot shows the monitor green after a few minutes.

---

## Phase 10. Get your numbers

Now that it's live, measure the one thing the README leaves blank:

```bash
cd ~/limn
set -a && source .env && set +a
pnpm loadtest --peers 25 --duration 30 --rate 8
```

It opens 25 real WebSockets, embeds a send timestamp in each frame and reads it
back at the receivers, so the p50/p95/p99 it reports is the full round trip
through Supabase, not local send time. Results are written to
`loadtest-results/`.

Start small (`--peers 5 --duration 10`) to confirm it connects before running the
full thing. It prints its projected message count first and refuses runs over
200k without `--yes`.

**Watch your quota.** Supabase free allows 2M messages/month, and every
*delivered* frame counts. A broadcast to 25 peers is 25 messages. A 25-peer,
30-second, 8/s run is roughly 72k.

---

## Quick reference

```bash
pnpm dev                  # web :3000 + vision :8000
pnpm test                 # all 52 tests across TS, Python, SQL
pnpm build                # production build
pnpm loadtest             # realtime benchmark
PGUSER=$(whoami) ./supabase/tests/run.sh    # security assertions
supabase db push          # apply new migrations
```

---

## When something breaks

| Symptom | Cause |
|---|---|
| Landing page throws on "Start drawing" | Anonymous sign-ins not enabled (Phase 2c) |
| Subscribe fails with a policy error | `...000300_rls.sql` didn't apply; re-run `db push` |
| Second window shows no cursor | Check both are the *same* board id; a share link without `?t=` grants nothing |
| Snapping never fires | Only freehand (pencil) strokes are recognised. The rectangle *tool* is already a rectangle |
| Beautify returns 502 | `GEMINI_API_KEY` missing or rate-limited |
| Photo trace times out | Cold Render instance; first request after a sleep pays ~50s |
| Photo trace fails only in production | `ALLOWED_ORIGINS` (Phase 8) |
| Build fails mentioning `serverEnv()` | Something imported it from a client component, which is the guard working |
| `ximgproc` is False | You have `opencv-python`, not `opencv-contrib-python` |
| Vercel build finds no Next.js app | Root Directory isn't `apps/web` (Phase 7.2) |
