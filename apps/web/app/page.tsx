import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { startDrawing } from "@/app/actions";
import StrokeMorph from "@/components/StrokeMorph";
import type { PlatformStats } from "@/lib/supabase/types";

/**
 * Landing page.
 *
 * Committed to one dark violet world rather than following the viewer's theme.
 * The canvas itself is a bright working surface, so the page around it reads as
 * the room the whiteboard is in, and the ink is the only thing that glows.
 *
 * The hero runs the actual stroke recogniser rather than describing it.
 */

export const revalidate = 60;

const format = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const SPEC = [
  {
    key: "as you draw",
    title: "Strokes snap themselves",
    body: "Every freehand stroke is classified the moment you lift the pen and replaced with a real rectangle, ellipse, diamond or arrow. Same frame, in your browser, no round trip. It declines rather than guessing, and one undo gives your wobble back.",
    value: "95.8%",
    unit: "accuracy",
  },
  {
    key: "together",
    title: "Invite anyone, draw at once",
    body: "Send someone the board link. They sign in, appear on the canvas with a named cursor, and every stroke lands on both screens as it is drawn. There is no sync server: the browsers merge each other's edits directly, and pick one of themselves to do the saving.",
    value: "0",
    unit: "servers",
  },
  {
    key: "from paper",
    title: "Photograph a real whiteboard",
    body: "OpenCV flattens the perspective, separates ink from board under glare, thins every stroke to its centreline and traces it back into shapes you can move and edit. Not a picture pasted onto the canvas.",
    value: "4/4",
    unit: "recovered",
  },
  {
    key: "when it helps",
    title: "Cleans up, or says it cannot",
    body: "Hand it a diagram and it redraws the whole thing where you put it, with shared baselines and properly bound arrows. Hand it a drawing and it tells you so, rather than forcing your sketch into boxes to fit what it knows how to make.",
    value: "3",
    unit: "AI modes",
  },
];

export default async function LandingPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const { data } = await supabase.rpc("platform_stats");
  const stats = data as PlatformStats | null;

  return (
    <div className="landing">
      <div className="paper" aria-hidden />

      <div className="shell">
        <header className="bar">
          <span className="mark">limn</span>
          <nav>
            <a href="https://github.com/alexli8408/limn">source</a>
            {auth.user ? (
              <Link href="/dashboard">boards</Link>
            ) : (
              <Link href="/signin">sign in</Link>
            )}
          </nav>
        </header>
        <hr className="rule" />

        <main>
          <section className="hero">
            <div>
              <p className="eyebrow">realtime collaborative whiteboard</p>
              <h1>
                Draw badly.
                <br />
                <span>Leave it looking deliberate.</span>
              </h1>
              <p className="lede">
                Sketch with anyone, live. Rough strokes become clean shapes as
                you draw, and a whole messy diagram can be redrawn properly
                without losing what you meant by it.
              </p>
              <div className="cta">
                {auth.user ? (
                  <form action={startDrawing}>
                    <button type="submit" className="primary">
                      New board
                    </button>
                  </form>
                ) : (
                  <Link href="/signin" className="primary">
                    Start drawing
                  </Link>
                )}
                <span className="aside">
                  {auth.user ? "signed in" : "google or email · free"}
                </span>
              </div>
            </div>

            <StrokeMorph />
          </section>

          {/* A hairline in place of the counters when the figures are not
              available, so a failed stats call reads as a quieter page rather
              than as a hole where something was clearly meant to be. */}
          {!stats && <hr className="rule" />}

          {stats && (
            <section className="counters" aria-label="Usage">
              {(
                [
                  [format(stats.boards), "boards"],
                  [format(stats.elements), "elements synced"],
                  [format(stats.ai_generations), "diagrams"],
                  [format(stats.vision_shapes), "shapes off photos"],
                ] as [string, string][]
              ).map(([value, label]) => (
                <div key={label}>
                  <span className="value">{value}</span>
                  <span className="label">{label}</span>
                </div>
              ))}
            </section>
          )}

          <section className="spec">
            {SPEC.map((row) => (
              <div className="spec-row" key={row.title}>
                <p className="spec-key">{row.key}</p>
                <div className="spec-body">
                  <h2>{row.title}</h2>
                  <p>{row.body}</p>
                </div>
                <p className="spec-value">
                  <strong>{row.value}</strong>
                  <span>{row.unit}</span>
                </p>
              </div>
            ))}
          </section>

          <section className="closer">
            <h2>Open a board and scribble something.</h2>
            {auth.user ? (
              <form action={startDrawing}>
                <button type="submit" className="primary">
                  New board
                </button>
              </form>
            ) : (
              <Link href="/signin" className="primary">
                Start drawing
              </Link>
            )}
          </section>
        </main>

        <footer className="foot">
          <span>Excalidraw · Supabase · OpenCV · Gemini</span>
          {stats && (
            <span>
              ai p50 {stats.ai_latency_p50_ms}ms · vision p50{" "}
              {stats.vision_latency_p50_ms}ms · {stats.boards_active_24h} active today
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
