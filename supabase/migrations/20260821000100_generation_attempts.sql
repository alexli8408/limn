-- Records how many Gemini calls a generation actually took, and whether the
-- model that answered is the one that was asked for.
--
-- latency_ms used to be timed inside the retry recursion, so it measured the
-- last attempt only: a request that failed twice and succeeded on the third was
-- written down as fast as one that worked first time, and ai_latency_p50_ms on
-- the landing page inherited the understatement. The timing is fixed in
-- lib/ai/gemini.ts, but a fixed number is still unreadable without these two.
-- A 20s p95 means something different depending on whether it is one slow call
-- or three quick ones, and a pro-quality figure means nothing if the fallback
-- quietly served flash.
--
-- Defaults match the common case, one call on the model asked for, so existing
-- rows stay honest rather than turning into nulls.
alter table public.ai_generations
  add column if not exists attempts  integer not null default 1,
  add column if not exists fell_back boolean not null default false;
