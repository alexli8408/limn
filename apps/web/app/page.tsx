import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { startDrawing } from "@/app/actions";
import type { PlatformStats } from "@/lib/supabase/types";

/**
 * Landing page. The counters are real numbers out of Postgres, not decoration —
 * they are the same aggregates the README quotes.
 */

export const revalidate = 60;

const FEATURES = [
  {
    title: "Realtime, no server",
    body: "Sync rides Supabase Realtime. Convergence, persistence and catch-up are all peer-side: a total order on (version, versionNonce) merges concurrent edits, and the peers elect one of themselves to persist.",
  },
  {
    title: "Strokes that snap",
    body: "A freehand stroke is classified and replaced in the same frame the pen lifts. 95.8% accurate over a 600-stroke benchmark, and it declines rather than guess — one Ctrl+Z gets your wobble back.",
  },
  {
    title: "Photo to diagram",
    body: "Photograph a physical whiteboard. OpenCV flattens the perspective, thins the ink to a centreline and traces it into shapes you can actually edit.",
  },
  {
    title: "Beautify, not rewrite",
    body: "Gemini reads the sketch and returns structure, never raw scene JSON. A deterministic compiler places it — so your arrangement survives, and arrows are genuinely bound.",
  },
];

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export default async function LandingPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const { data: stats } = await supabase.rpc("platform_stats");
  const s = stats as PlatformStats | null;

  const counters: { label: string; value: string }[] = s
    ? [
        { label: "boards", value: formatCount(s.boards) },
        { label: "elements synced", value: formatCount(s.elements) },
        { label: "AI diagrams", value: formatCount(s.ai_generations) },
        { label: "shapes from photos", value: formatCount(s.vision_shapes) },
      ]
    : [];

  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-sm text-neutral-400">limn</p>

      <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
        A whiteboard that
        <br />
        cleans up after you.
      </h1>

      <p className="mt-5 max-w-xl text-base leading-relaxed text-neutral-600 dark:text-neutral-300">
        Sketch with anyone, in realtime. Rough strokes become clean shapes as you
        draw, and a whole messy sketch can be redrawn as a proper diagram —
        without changing what you meant by it.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <form action={startDrawing}>
          <button
            type="submit"
            className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Start drawing
          </button>
        </form>
        {auth.user && (
          <Link
            href="/dashboard"
            className="rounded-lg border border-neutral-300 px-5 py-2.5 text-sm font-medium transition hover:border-neutral-500 dark:border-neutral-700"
          >
            Your boards
          </Link>
        )}
        <span className="text-xs text-neutral-400">No account needed.</span>
      </div>

      {counters.length > 0 && (
        <dl className="mt-14 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-neutral-200 pt-8 sm:grid-cols-4 dark:border-neutral-800">
          {counters.map((counter) => (
            <div key={counter.label}>
              <dd className="font-mono text-2xl font-semibold tabular-nums">
                {counter.value}
              </dd>
              <dt className="mt-0.5 text-xs text-neutral-500">{counter.label}</dt>
            </div>
          ))}
        </dl>
      )}

      <section className="mt-16 grid gap-8 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <div key={feature.title}>
            <h2 className="text-sm font-semibold">{feature.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              {feature.body}
            </p>
          </div>
        ))}
      </section>

      {s && (
        <p className="mt-16 border-t border-neutral-200 pt-6 font-mono text-xs text-neutral-400 dark:border-neutral-800">
          AI p50 {s.ai_latency_p50_ms}ms · p95 {s.ai_latency_p95_ms}ms · vision p50{" "}
          {s.vision_latency_p50_ms}ms · {s.boards_active_24h} boards active in the last
          24h
        </p>
      )}
    </main>
  );
}
