/**
 * Realtime load test.
 *
 * Opens N websockets against a real Supabase Realtime channel, has them
 * broadcast scene deltas at a fixed rate, and measures how long each frame takes
 * to come back out at the other peers.
 *
 * The point is to produce numbers that are actually defensible. Latency is
 * measured end to end, a timestamp is written into the element payload by the
 * sender and compared against the receiver's clock in the same process, so there
 * is no clock skew to argue about and the figure includes the full round trip
 * through Supabase rather than just local send time.
 *
 * Usage:
 *   pnpm loadtest --peers 25 --duration 30 --rate 8
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, and a
 * project with the migrations in supabase/ applied.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import {
  BoardEvent,
  PROTOCOL_VERSION,
  REALTIME_EVENTS_PER_SECOND,
  boardChannel,
  decodeEvent,
} from "@limn/protocol";

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

interface Config {
  peers: number;
  durationS: number;
  /** Scene frames per second, per publishing peer. */
  rate: number;
  /** Elements per frame. Real drags touch one or two. */
  elementsPerFrame: number;
  /** Fraction of peers that publish; the rest only receive. */
  publisherRatio: number;
  outDir: string;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Config {
  const get = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    peers: Math.max(2, get("peers", 20)),
    durationS: Math.max(3, get("duration", 20)),
    rate: Math.max(1, get("rate", 8)),
    elementsPerFrame: Math.max(1, get("elements", 2)),
    publisherRatio: Math.min(1, Math.max(0.1, get("publishers", 0.5))),
    outDir: "loadtest-results",
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

/* ------------------------------------------------------------------ */
/* statistics                                                          */
/* ------------------------------------------------------------------ */

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarise(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: Math.round((sorted[0] ?? 0) * 100) / 100,
    p50: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95: Math.round(percentile(sorted, 0.95) * 100) / 100,
    p99: Math.round(percentile(sorted, 0.99) * 100) / 100,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
    mean: sorted.length ? Math.round((sum / sorted.length) * 100) / 100 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface Peer {
  id: string;
  index: number;
  client: SupabaseClient;
  channel: RealtimeChannel;
  publisher: boolean;
  subscribeMs: number;
  received: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.\n" +
        "Copy .env.example to .env and fill in your project's values, then:\n" +
        "  set -a && source .env && set +a && pnpm loadtest",
    );
    process.exit(1);
  }

  const publishers = Math.max(1, Math.round(config.peers * config.publisherRatio));
  // Every published frame fans out to every other subscriber, so the message
  // count against a project's quota grows with peers x rate x duration.
  const projectedSent = publishers * config.rate * config.durationS;
  const projectedDelivered = projectedSent * (config.peers - 1);

  console.log("Limn realtime load test");
  console.log("───────────────────────");
  console.log(`  peers            ${config.peers} (${publishers} publishing)`);
  console.log(`  duration         ${config.durationS}s`);
  console.log(`  rate             ${config.rate} frames/s per publisher`);
  console.log(`  elements/frame   ${config.elementsPerFrame}`);
  console.log(`  client ceiling   ${REALTIME_EVENTS_PER_SECOND} events/s`);
  console.log(
    `\n  projected: ~${projectedSent.toLocaleString()} sent, ` +
      `~${projectedDelivered.toLocaleString()} delivered`,
  );
  console.log(
    "  note: Supabase's free tier allows 200 concurrent connections and 2M\n" +
      "        messages/month. A delivered frame counts against that quota.\n",
  );

  if (!config.yes && projectedDelivered > 200_000) {
    console.error(
      "That run would use over 200k messages. Re-run with --yes if you meant it.",
    );
    process.exit(1);
  }

  // One anonymous user, shared by every virtual peer. They still each open their
  // own websocket and register their own presence, which is what is being
  // measured; minting N users would only pollute auth.users.
  const admin = createClient(url, anonKey);
  const { data: session, error: authError } = await admin.auth.signInAnonymously();
  if (authError || !session.session) {
    console.error(`Could not sign in anonymously: ${authError?.message}`);
    console.error("Enable anonymous sign-ins in Supabase → Authentication → Providers.");
    process.exit(1);
  }
  const accessToken = session.session.access_token;

  const { data: board, error: boardError } = await admin.rpc("create_board", {
    p_title: `loadtest ${new Date().toISOString()}`,
  });
  if (boardError || !board) {
    console.error(`Could not create a board: ${boardError?.message}`);
    process.exit(1);
  }
  const boardId = (board as { id: string }).id;
  console.log(`  board            ${boardId}\n`);

  /* -------------------------------------------------------------- */
  /* connect                                                         */
  /* -------------------------------------------------------------- */

  const latencies: number[] = [];
  const peers: Peer[] = [];
  let delivered = 0;
  let malformed = 0;
  let sent = 0;

  process.stdout.write("  connecting");

  for (let index = 0; index < config.peers; index++) {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: REALTIME_EVENTS_PER_SECOND } },
    });
    await client.realtime.setAuth(accessToken);

    const peerId = `lt_${index.toString().padStart(3, "0")}`;
    const channel = client.channel(boardChannel(boardId), {
      config: {
        private: true,
        broadcast: { self: false, ack: false },
        presence: { key: peerId },
      },
    });

    const peer: Peer = {
      id: peerId,
      index,
      client,
      channel,
      publisher: index < publishers,
      subscribeMs: 0,
      received: 0,
    };

    channel.on("broadcast", { event: BoardEvent.SCENE }, ({ payload }) => {
      const result = decodeEvent(BoardEvent.SCENE, payload);
      if (!result.ok) {
        malformed++;
        return;
      }
      const first = result.data.elements[0] as { t0?: number } | undefined;
      if (typeof first?.t0 === "number") {
        latencies.push(Date.now() - first.t0);
      }
      delivered++;
      peer.received++;
    });

    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`peer ${peerId} subscribe timed out`)), 20_000);
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          reject(error ?? new Error(`peer ${peerId} failed: ${status}`));
        }
      });
    }).catch((error: Error) => {
      console.error(`\n  ${error.message}`);
      console.error(
        "  If this is a policy error, check the realtime.messages policies in\n" +
          "  supabase/migrations/*_rls.sql are applied.",
      );
      process.exit(1);
    });

    peer.subscribeMs = Date.now() - startedAt;
    await channel.track({
      peerId,
      userId: session.session.user.id,
      name: peerId,
      color: "#1971c2",
      role: "editor",
      guest: true,
      joinedAt: Date.now(),
    });

    peers.push(peer);
    if (index % 5 === 4) process.stdout.write(".");
    // Stagger slightly: opening N sockets in a tight loop trips Realtime's
    // per-connection rate limiting and the failures look like capacity limits.
    await sleep(40);
  }

  console.log(` ${peers.length} connected`);
  console.log(
    `  subscribe        p50 ${summarise(peers.map((p) => p.subscribeMs)).p50}ms · ` +
      `p95 ${summarise(peers.map((p) => p.subscribeMs)).p95}ms\n`,
  );

  /* -------------------------------------------------------------- */
  /* publish                                                         */
  /* -------------------------------------------------------------- */

  const startedAt = Date.now();
  const endAt = startedAt + config.durationS * 1000;
  const intervalMs = 1000 / config.rate;

  const progress = setInterval(() => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const stats = summarise(latencies);
    process.stdout.write(
      `\r  ${elapsed}s/${config.durationS}s · sent ${sent} · delivered ${delivered} · ` +
        `p50 ${stats.p50}ms · p95 ${stats.p95}ms    `,
    );
  }, 1000);

  const publishing = peers
    .filter((peer) => peer.publisher)
    .map(async (peer, publisherIndex) => {
      // Spread publishers across the interval so they do not all fire on the
      // same tick, which would measure a thundering herd rather than a workload.
      await sleep((intervalMs / publishers) * publisherIndex);

      let frame = 0;
      while (Date.now() < endAt) {
        const elements = Array.from({ length: config.elementsPerFrame }, (_, i) => ({
          id: `${peer.id}-e${i}`,
          version: frame + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
          // Read back by receivers to compute end-to-end latency.
          t0: Date.now(),
          x: Math.random() * 2000,
          y: Math.random() * 2000,
          points: [
            [0, 0],
            [Math.random() * 200, Math.random() * 200],
          ],
        }));

        peer.channel.send({
          type: "broadcast",
          event: BoardEvent.SCENE,
          payload: { from: peer.id, v: PROTOCOL_VERSION, elements },
        });
        sent++;
        frame++;
        await sleep(intervalMs);
      }
    });

  await Promise.all(publishing);
  // Let the tail of in-flight frames arrive before measuring loss.
  await sleep(2000);
  clearInterval(progress);
  process.stdout.write("\r".padEnd(100) + "\r");

  /* -------------------------------------------------------------- */
  /* report                                                          */
  /* -------------------------------------------------------------- */

  const elapsedS = (Date.now() - startedAt) / 1000;
  const expected = sent * (config.peers - 1);
  const stats = summarise(latencies);
  const deliveryRate = expected > 0 ? delivered / expected : 0;

  const report = {
    at: new Date().toISOString(),
    config: {
      peers: config.peers,
      publishers,
      durationS: config.durationS,
      rate: config.rate,
      elementsPerFrame: config.elementsPerFrame,
    },
    throughput: {
      framesSent: sent,
      framesDelivered: delivered,
      framesExpected: expected,
      deliveryRate: Math.round(deliveryRate * 10_000) / 10_000,
      sendRatePerS: Math.round((sent / elapsedS) * 10) / 10,
      deliverRatePerS: Math.round((delivered / elapsedS) * 10) / 10,
      elementsPerS: Math.round((delivered * config.elementsPerFrame) / elapsedS),
      malformed,
    },
    latencyMs: stats,
    subscribeMs: summarise(peers.map((p) => p.subscribeMs)),
  };

  console.log("Results");
  console.log("───────");
  console.log(`  peers connected      ${config.peers} (${publishers} publishing)`);
  console.log(`  frames sent          ${sent.toLocaleString()} (${report.throughput.sendRatePerS}/s)`);
  console.log(
    `  frames delivered     ${delivered.toLocaleString()} (${report.throughput.deliverRatePerS}/s)`,
  );
  console.log(
    `  delivery rate        ${(deliveryRate * 100).toFixed(2)}% of ${expected.toLocaleString()} expected`,
  );
  console.log(`  element updates/s    ${report.throughput.elementsPerS.toLocaleString()}`);
  console.log(
    `  latency              p50 ${stats.p50}ms · p95 ${stats.p95}ms · p99 ${stats.p99}ms · max ${stats.max}ms`,
  );
  if (malformed > 0) console.log(`  malformed frames     ${malformed}`);

  mkdirSync(config.outDir, { recursive: true });
  const file = `${config.outDir}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n  written to ${file}`);

  /* -------------------------------------------------------------- */
  /* teardown                                                        */
  /* -------------------------------------------------------------- */

  await Promise.all(peers.map((peer) => peer.client.removeChannel(peer.channel)));
  // Leave no trace: the board would otherwise show up in the dashboard and skew
  // the stats the landing page reports.
  await admin.from("boards").delete().eq("id", boardId);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("\nload test failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
