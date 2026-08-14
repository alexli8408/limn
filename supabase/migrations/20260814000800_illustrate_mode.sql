-- Records illustration runs alongside the other AI modes.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction on PG 12+ provided
-- the new label is not *used* in the same transaction, which is why this is its
-- own migration rather than part of one that also inserts rows.
alter type public.ai_mode add value if not exists 'illustrate';
