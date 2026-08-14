-- Adds an unused 'illustrate' label to ai_mode.
--
-- The illustration feature it was added for has been removed: image generation
-- has no Gemini free-tier allowance, so the feature could not run without
-- billing. The label stays because it is already applied to the deployed
-- database, and removing a label from a Postgres enum means recreating the type
-- and every column that uses it. An unused label costs nothing.
--
-- If illustration comes back, this is already here.
alter type public.ai_mode add value if not exists 'illustrate';
