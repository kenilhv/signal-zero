-- Signal Zero — 002: columns the in-memory store has and 001 did not.
--
-- WHY THIS EXISTS
--
-- The cutover from src/store.js to Postgres is supposed to be a SWAP, not a
-- rewrite of every caller: a repository function must hand back an object with
-- the same keys the in-memory one did, or the change stops being a persistence
-- change and becomes a change to what the UI can render. Four fields the store
-- carries had nowhere to land in 001:
--
--   settlements.aliases          src/data/gazetteer.json carries aliases and
--                                triage matches settlement names against them.
--                                Reading settlements back from a table without
--                                this column would silently degrade matching.
--   clusters.source_type_diversity  src/pipeline/dedup.js:502 computes it and
--                                web/app.js:1638 renders it ("diversity N").
--   ranked.cohort_sample_gaps    web/app.js:1512 renders "N observed gaps"; it
--                                is how the UI says how much evidence the
--                                cohort baseline actually had.
--   ranked.neighbor_mean_surprisal / neighbor_count
--                                web/app.js:1311,1524 render both.
--
-- NULLABILITY, deliberately split two ways:
--   counts (cohort_sample_gaps, neighbor_count, source_type_diversity) are
--   NOT NULL DEFAULT 0 because rank.js and dedup.js always compute them and 0
--   genuinely means "none", not "unknown".
--   neighbor_mean_surprisal is NULLable with NO default: a settlement with no
--   corridor neighbours has no neighbourhood mean, and inventing 0 for it would
--   be the same class of lie as coalescing last_observed_at. Hard rule 4 is
--   about timestamps first but the reasoning is not specific to timestamps.
--
-- IF NOT EXISTS on every ALTER: 001 was applied to the live database by hand,
-- and a hand-applied database is exactly the kind that may already have had one
-- of these bolted on. Re-running must be a no-op, not an error.

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN settlements.aliases IS
  'Alternate spellings from src/data/gazetteer.json. Triage matches report text against these.';

ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS source_type_diversity INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ranked_snapshots
  ADD COLUMN IF NOT EXISTS cohort_sample_gaps INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ranked_snapshots
  ADD COLUMN IF NOT EXISTS neighbor_mean_surprisal DOUBLE PRECISION;

ALTER TABLE ranked_snapshots
  ADD COLUMN IF NOT EXISTS neighbor_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN ranked_snapshots.neighbor_mean_surprisal IS
  'NULL means this settlement has no corridor neighbours, so no neighbourhood mean exists. '
  'Not 0: 0 would assert that the neighbours were measured and found unsurprising.';
