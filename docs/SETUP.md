# Setup, from scratch

Ten phases. Phases 1–5 get it running on your machine, 6–9 put it on the
internet, and 10 measures what you built. You can stop after 5 and still have a
working app.

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
pnpm --filter @limn/protocol test    # 21 tests, convergence properties
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

It should apply thirteen migrations in order:

```
20260814000100_schema.sql             tables, triggers, revision pruning
20260814000200_functions.sql          access helpers, snapshot compare-and-swap
20260814000300_rls.sql                row-level security + Realtime authorization
20260814000400_storage.sql            buckets for images and thumbnails
20260814000500_grants.sql             explicit table privileges
20260814000600_tighten_grants.sql     revokes Supabase's permissive defaults
20260814000700_fix_guest_display_name.sql
20260814000800_illustrate_mode.sql    an enum label kept for compatibility
20260821000100_generation_attempts.sql  retry count and model actually used
20260821000200_thumbnail_policies.sql   re-creates the thumbnail bucket policies
20260821000300_fix_ownership_guard.sql  an editor could take a board off its owner
20260821000400_narrow_thumbnail_read.sql scopes thumbnail reads to can_read_board
20260821000500_thumbnail_path.sql       thumbnail_url holds a path, not a URL
```

The last one exists because the `board-thumbnails` policies written in
`...000400_storage.sql` did not survive the original push on at least one
project: uploading to `board-files` worked while the identical request against
`board-thumbnails` came back with `new row violates row-level security policy`.
Re-running the original migration cannot fix that, because a migration already
recorded as applied is skipped, so the policies are re-created in a new file.
Symptom if it has not been applied: every board in the dashboard shows a blank
thumbnail and the console logs an RLS error on save.

### 2c. Set up sign-in

Boards belong to people, not to browsers, so there is no way in without an
account. Two providers, and you want both.

**Email and password.** On by default. One setting needs your attention:

Dashboard → **Authentication → Sign In / Providers → Email → Confirm email.**

Leave it on and Supabase emails every new account a confirmation link, through
a shared SMTP server capped at a couple of messages an hour. That cap is not a
per-project quota you can wait out under load, it returns
`over_email_send_rate_limit` and the signup fails outright. For a project people
are going to try from a link, either:

- turn **Confirm email** off, so an account works the moment it is created, or
- set your own SMTP under **Project Settings → Authentication → SMTP Settings**,
  which is the right answer if this is going in front of real users.

**Google.** Dashboard → **Authentication → Sign In / Providers → Google →
enable**, then paste in a client ID and secret from the Google Cloud console
(APIs & Services → Credentials → OAuth client ID → Web application).

Google needs two lists filled in, and both matter:

- *Authorised JavaScript origins*: `http://localhost:3000` and your Vercel
  domain.
- *Authorised redirect URIs*: the callback URL Supabase shows you on that same
  provider page, which looks like
  `https://<project-ref>.supabase.co/auth/v1/callback`.

Then, back in Supabase, Dashboard → **Authentication → URL Configuration**:

- **Site URL**: your production origin.
- **Redirect URLs**: add `http://localhost:3000/**` and
  `https://your-app.vercel.app/**`. The app sends people back to
  `/auth/callback`, and Supabase refuses any redirect target not on this list.

**Anonymous sign-ins** are no longer used and can be left off. If you enabled
them for an earlier version, boards owned by those guest sessions are still in
the database but nobody can sign in as their owner again.

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
key** → copy it.

**What the free tier actually gives you**, measured against a real key rather
than read off a docs page:

| | Free tier |
|---|---|
| Text models (`gemini-3.6-flash`, etc.) | 20 requests per day, **per model** |
| Image models (`gemini-3.1-flash-image`, etc.) | none at all |

The daily allowance is scoped per model, so switching `GEMINI_MODEL` to
`gemini-3.1-flash-lite` or `gemini-3.5-flash` gives you a fresh 20. That is the
practical way to keep demoing after you run out.

Image models are the exception: every one of them returns 429 listing quotas
with no value, on a key that has never called them, which is how Google reports
"no allowance on this tier". Nothing in the app calls one any more, so this
costs you nothing. Beautify, From a photo, Fix the writing and Draw from a
description are all text calls and all work on a free key. Snapping a stroke is
local geometry and spends no request at all.

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

1. **Click "Start drawing," then create an account or use Google.** → lands on
   the dashboard, and "New board" opens a board.
   *Exercises: auth, the profile trigger, `create_board` RPC, RLS.*
2. **Draw a rough rectangle freehand.** → snaps to a clean rectangle when you
   lift the pen. The header shows `Snap on 1`.
   *Exercises: the client recogniser. No network involved.*
3. **Draw a deliberate squiggle.** → stays a squiggle.
   *Exercises: the recogniser declining, which matters as much as accepting.*
4. **Ctrl+Z after a snap.** → your original wobbly stroke returns.
5. **Hit Share, copy the link, open it in a private window and sign in as
   somebody else.** → two cursors, and drawing in one window appears in the
   other within about a second. The board now shows up under "Shared with you"
   on the second account's dashboard.
   *Exercises: share tokens, `claim_board_access`, Realtime broadcast, presence,
   the merge.*
6. **Wait ~5 seconds, reload.** → your drawing is still there, header shows a
   bumped `v` number.
   *Exercises: writer election and the snapshot compare-and-swap.*
7. **Draw a few boxes joined by arrows, select them, then hit the violet
   "✦ Beautify" button at the bottom right and, in the panel, the "Beautify"
   button.** → the sketch is redrawn square and aligned, with the arrows bound
   to the boxes, so dragging a box drags its arrows with it. The panel reports
   node and edge counts, the latency and which model answered.
   Select first: with nothing selected the whole board goes up as one sketch,
   and by now it also holds the rectangle from step 2 and the squiggle from
   step 3.
   *Exercises: Gemini, constrained decoding, the layout compiler.*
8. **Now draw a picture somewhere else on the board: a house as a square with a
   triangle on top, two windows, a sun, a line for the ground. Select it, then
   "✦ Beautify" → "Beautify".** → nothing is replaced. Your own strokes stay,
   squared up and lined up: the walls straighten, the windows match each other,
   the sun rounds. Count the shapes first if you like; the same number is there
   afterwards.
   Turn Snap off in the header before you draw this one. Leave it on and every
   stroke is cleaned as you lift the pen, so the straightening has nothing left
   to do and only the lining-up shows.
   *Exercises: the drawing path. This is the case that used to come back as a
   refusal, so the regressions to watch for are a decline, or boxes and arrows
   where your house was.*
9. **Label two or three shapes with deliberate typos, then "✦ Beautify" → "Fix
   the writing".** → the labels come back spelled and capitalised properly and
   nothing else moves. With nothing to correct it says so rather than editing.
   *Exercises: the rewrite pass, which returns replacement text per element id
   and no geometry at all.*
10. **"✦ Beautify" → "From a photo"**, which opens a file picker, and pick a
    photo of a whiteboard or a pen-and-paper sketch. → shapes land beside what
    is already on the board as editable elements, and any handwriting on them
    comes back as text sitting where it was written.
    *Exercises: the OpenCV pipeline end to end, and the Gemini transcription
    pass that runs beside it.*
11. **Go back to the dashboard.** → the board you just drew on shows a thumbnail
    of it rather than an empty tile.
    *Exercises: the `board-thumbnails` bucket and its storage policies. A blank
    tile here almost always means `20260821000200_thumbnail_policies.sql` has
    not been pushed.*

If step 5 fails with a policy error, the `realtime.messages` policies from
migration `...000300_rls.sql` did not apply. Re-run `./scripts/db.sh push`.

Steps 7 to 10 each spend one Gemini request, four of the twenty a free key gets
per day. The trace in step 10 runs on your own vision service and costs none of
them. If you plan to run the list more than once, read the note on switching
`GEMINI_MODEL` in Phase 3 first.

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

> **Check:** on the deployed site, "✦ Beautify" → "From a photo" works.

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
pnpm build:packages       # ALWAYS before pnpm test, see below
pnpm test                 # protocol, shapes, web, db, vision, in that order
pnpm build                # production build
pnpm loadtest             # realtime benchmark
PGUSER=$(whoami) ./supabase/tests/run.sh    # security assertions
./scripts/db.sh push      # apply new migrations (see 2b, plain db push needs IPv6)
```

**`pnpm test` never builds.** `packages/protocol` and `packages/shapes` both run
`node --test dist/*.test.js` with no pretest hook, and `apps/web` resolves
`@limn/shapes` to `dist/` too. Edit a source file, run the suite, and you are
grading the previous build: it goes green and means nothing. Run
`pnpm build:packages && pnpm test`.

**`pnpm test` calls the real Gemini API.** `lib/ai/live-test.ts` reads the
repo-root `.env`, not `apps/web/.env.local`, so a key there makes five
integration tests hit the network and spend free-tier quota (20/day per model).
One of them is the whole drawing path, fixture to polished elements, which is
the only way to check that the model still groups a house instead of calling it
a diagram. A spent quota still reports green: the helper catches
`RESOURCE_EXHAUSTED`, prints `skipped:` to stderr, and the test passes. For the
offline set only, run from `apps/web`:

```bash
pnpm exec vitest run --exclude '**/*.integration.test.ts' --exclude '**/node_modules/**'
```

Repeat the second `--exclude`: passing one on the CLI replaces vitest's
defaults, so without it `node_modules` gets scanned. Setting `GEMINI_API_KEY=`
empty does not work, because `loadEnv` treats an empty string as unset and
writes the key back from `.env`.


---

## When something breaks

| Symptom | Cause |
|---|---|
| Signup fails with `over_email_send_rate_limit` | Supabase's shared SMTP is capped at a couple of mails an hour. Turn off **Confirm email** or add your own SMTP (Phase 2c) |
| Google sign-in returns to `/signin` with an error | The callback URL is not in Supabase's **Redirect URLs**, or the Supabase callback is missing from the Google client's redirect URIs (Phase 2c) |
| Signed in, but the board says you cannot read it | The share link was opened without `?t=`, so no collaborator row was ever created |
| Subscribe fails with a policy error | `...000300_rls.sql` didn't apply; re-run `db push` |
| Second window shows no cursor | Check both are the *same* board id; a share link without `?t=` grants nothing |
| Snapping never fires | Only freehand (pencil) strokes are recognised. The rectangle *tool* is already a rectangle |
| Beautify turns a picture into boxes and arrows | The whole selection is classified once, as a diagram or a drawing. A board holding both has to be one of them, so select just the picture |
| Beautify says nothing moved | The model named groups but none of the tidying it chose changed a coordinate, which is the honest answer on a sketch that is already square |
| Beautify returns 502 | `GEMINI_API_KEY` missing or rate-limited |
| Dashboard tiles are all blank | `...000200_thumbnail_policies.sql` has not been pushed, so the upload is refused by RLS |
| Photo trace returns shapes but no words | Handwriting is transcribed by Gemini, not OpenCV, so this is the same `GEMINI_API_KEY` as Beautify |
| Photo trace times out | Cold Render instance; first request after a sleep pays ~50s |
| Photo trace fails only in production | `ALLOWED_ORIGINS` (Phase 8) |
| Build fails mentioning `serverEnv()` | Something imported it from a client component, which is the guard working |
| `ximgproc` is False | You have `opencv-python`, not `opencv-contrib-python` |
| Vercel build finds no Next.js app | Root Directory isn't `apps/web` (Phase 7.2) |
