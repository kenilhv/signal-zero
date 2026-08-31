-- Signal Zero — initial schema
--
-- THE ONE RULE THIS SCHEMA EXISTS TO ENFORCE
--
-- The product measures TIME SINCE THE LAST CONFIRMING OBSERVATION. An in-memory
-- store cannot measure that across a restart, which made persistence a
-- correctness requirement rather than an infrastructure nicety: a silence clock
-- that forgets time cannot measure the only thing it claims to measure.
--
-- The dangerous failure is not data loss. It is a NULL that gets coalesced.
-- `last_observed_at IS NULL` means "no report has ever reached us here" — hard
-- rule 4. The moment anything in the read path writes COALESCE(last_observed_at,
-- now()) or COALESCE(..., epoch), absence of data silently becomes a confirmed
-- observation and the product starts lying in exactly the direction it exists to
-- prevent. Every column below that can legitimately be unknown is NULLable on
-- purpose and must stay that way.
--
-- SHAPE
--   observations   append-only FACTS. Never updated, never deleted. The silence
--                  clock is derived from this table alone.
--   reports        what ingest fetched, keyed by run. Derived, replaceable.
--   clusters       dedup output, keyed by run. Derived, replaceable.
--   ranked_snapshots  the ranking as computed at a point in time, keyed by run.
--   checkpoint_items  the human gate. Mutable status, but see `approvals`.
--   approvals      append-only DECISION LOG. Who signed, when, which way.
--                  Separate from checkpoint_items because an audit trail that
--                  can be UPDATEd is not an audit trail.
--   incidents      append-only. Replaces a 200-item in-memory ring buffer that
--                  silently discarded the 201st failure.
--
-- This is an append-only FACT table plus derived projections. It is NOT event
-- sourcing, and that term is deliberately not used: state here is not a fold
-- over a log of every transition. Calling it event sourcing would not survive
-- one interview follow-up.
--
-- TRANSACTIONS: this file contains NO BEGIN/COMMIT. src/db/migrate.js wraps each
-- migration in exactly one transaction and records the ledger row inside that
-- same transaction, so "schema changed" and "migration recorded" commit together
-- or not at all. A COMMIT inside the file would end the runner transaction early
-- and split that pair. The runner REFUSES any migration containing transaction
-- control, so this is checked rather than trusted.


-- ---------------------------------------------------------------------------
-- Settlements: the gazetteer. Reference data, rarely changes.
-- ---------------------------------------------------------------------------
CREATE TABLE settlements (
  settlement_id   TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  district        TEXT        NOT NULL,
  lat             DOUBLE PRECISION NOT NULL,
  lon             DOUBLE PRECISION NOT NULL,
  population      INTEGER     NOT NULL CHECK (population >= 0),
  hazard_tier     SMALLINT    NOT NULL CHECK (hazard_tier BETWEEN 1 AND 3),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE settlements IS
  'Gazetteer of the Trishuli corridor. Reference data loaded from src/data/gazetteer.json.';

-- ---------------------------------------------------------------------------
-- Observations: THE fact table. Append-only.
-- ---------------------------------------------------------------------------
-- One row = one confirming observation that resolved to one settlement at one
-- instant. This is the ONLY input to the silence clock.
--
-- observed_at is NOT NULL because a row here asserts that an observation
-- happened at a known time. A report whose timestamp could not be parsed does
-- NOT get a row with a guessed time — it gets no row, and the settlement stays
-- silent. Guessing here would be the coalesce failure wearing a different hat.
CREATE TABLE observations (
  observation_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id   TEXT        NOT NULL REFERENCES settlements(settlement_id),
  observed_at     TIMESTAMPTZ NOT NULL,
  source_name     TEXT        NOT NULL,
  source_type     TEXT        NOT NULL,
  report_id       TEXT,
  cluster_id      TEXT,
  url             TEXT,
  title           TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The silence query is "most recent observation per settlement", so the index
-- is (settlement_id, observed_at DESC). A plain btree on settlement_id would
-- force a sort per settlement on every pass.
CREATE INDEX observations_settlement_time_idx
  ON observations (settlement_id, observed_at DESC);

COMMENT ON TABLE observations IS
  'Append-only. Never UPDATE or DELETE: the silence clock is derived from this table, '
  'so mutating history would retroactively change what the system claimed to know.';

-- ---------------------------------------------------------------------------
-- Runs: one pipeline pass.
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  status          TEXT        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'done', 'error')),
  error           TEXT,
  stats           JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Reports / clusters: derived per run. Safe to discard and recompute.
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  report_id       TEXT        NOT NULL,
  run_id          TEXT        NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  settlement_id   TEXT        REFERENCES settlements(settlement_id),
  source_name     TEXT,
  source_type     TEXT,
  url             TEXT,
  title           TEXT,
  text            TEXT,
  -- NULLable on purpose: an unparseable relative date ("2 days ago") must stay
  -- unknown rather than be stamped with the fetch time. docs/brightdata-serp-shape.md
  -- documents that trap, and a wrong timestamp is a wrong silence score.
  published_at    TIMESTAMPTZ,
  fetched_at      TIMESTAMPTZ NOT NULL,
  triage          JSONB,
  cluster_id      TEXT,
  PRIMARY KEY (run_id, report_id)
);

CREATE INDEX reports_run_idx ON reports (run_id);

CREATE TABLE clusters (
  cluster_id      TEXT        NOT NULL,
  run_id          TEXT        NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  settlement_id   TEXT        REFERENCES settlements(settlement_id),
  size            INTEGER     NOT NULL DEFAULT 0,
  confidence      DOUBLE PRECISION,
  member_ids      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (run_id, cluster_id)
);

-- ---------------------------------------------------------------------------
-- Ranked snapshots: the ranking as computed at a point in time.
-- ---------------------------------------------------------------------------
-- Kept per run rather than overwritten so "why was this ranked 3rd an hour ago"
-- is answerable. Every statistical field is NULLable: a settlement with no
-- fitted rate has no surprisal, and that is a fact to preserve, not a zero to
-- substitute.
CREATE TABLE ranked_snapshots (
  run_id              TEXT        NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  settlement_id       TEXT        NOT NULL REFERENCES settlements(settlement_id),
  rank                INTEGER     NOT NULL,
  -- NULL = no report has EVER resolved here. Never coalesce this.
  last_observed_at    TIMESTAMPTZ,
  silence_hours       DOUBLE PRECISION,
  expected_gap_hours  DOUBLE PRECISION,
  lambda_per_hour     DOUBLE PRECISION,
  surprisal           DOUBLE PRECISION,
  gi_z_score          DOUBLE PRECISION,
  own_z_score         DOUBLE PRECISION,
  neighbor_z_score    DOUBLE PRECISION,
  report_count        INTEGER     NOT NULL DEFAULT 0,
  corroboration_count INTEGER     NOT NULL DEFAULT 0,
  coverage_basis      TEXT,
  fit_basis           TEXT,
  cohort_key          TEXT,
  anomaly_type        TEXT,
  is_local_anomaly    BOOLEAN     NOT NULL DEFAULT false,
  is_regional_outage  BOOLEAN     NOT NULL DEFAULT false,
  is_solo_anomaly     BOOLEAN     NOT NULL DEFAULT false,
  is_escalation_candidate BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, settlement_id)
);

CREATE INDEX ranked_run_rank_idx ON ranked_snapshots (run_id, rank);

COMMENT ON COLUMN ranked_snapshots.last_observed_at IS
  'NULL means NO REPORT HAS EVER RESOLVED HERE. Hard rule 4. Never COALESCE this '
  'to now(), to epoch, or to anything else: doing so converts absence of data into '
  'a confirmed observation, which is the exact failure this product exists to prevent.';

-- ---------------------------------------------------------------------------
-- Checkpoint: the human gate.
-- ---------------------------------------------------------------------------
CREATE TABLE checkpoint_items (
  id              TEXT PRIMARY KEY,
  run_id          TEXT        REFERENCES runs(run_id) ON DELETE SET NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('escalation', 'ambiguous-match')),
  settlement_id   TEXT        REFERENCES settlements(settlement_id),
  title           TEXT        NOT NULL,
  evidence        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  provenance      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX checkpoint_status_idx ON checkpoint_items (status, created_at DESC);

-- The decision log. APPEND-ONLY and separate from checkpoint_items on purpose:
-- an audit trail you can UPDATE is not an audit trail. checkpoint_items.status
-- is a convenience projection of the latest row here.
--
-- approved_by is NOT NULL with a non-blank CHECK. The product's headline claim
-- contains the word "named"; the database is where that stops being a UI
-- convention. src/pipeline/checkpoint.js already returns HTTP 400 on a blank
-- name — this makes it impossible to write one even if that check is bypassed.
CREATE TABLE approvals (
  approval_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         TEXT        NOT NULL REFERENCES checkpoint_items(id) ON DELETE CASCADE,
  decision        TEXT        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  approved_by     TEXT        NOT NULL CHECK (btrim(approved_by) <> ''),
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  shortlist       JSONB
);

CREATE INDEX approvals_item_idx ON approvals (item_id, decided_at DESC);

COMMENT ON TABLE approvals IS
  'Append-only decision log. approved_by is NOT NULL and non-blank at the database '
  'level so an anonymous approval cannot be written even if application code is bypassed.';

-- ---------------------------------------------------------------------------
-- Incidents: append-only fail feed.
-- ---------------------------------------------------------------------------
-- Replaces a 200-item in-memory ring buffer. That buffer silently discarded the
-- 201st failure, which is the wrong behaviour for the one surface whose entire
-- job is to make failure visible.
CREATE TABLE incidents (
  id              TEXT PRIMARY KEY,
  run_id          TEXT        REFERENCES runs(run_id) ON DELETE SET NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT        NOT NULL,
  message         TEXT        NOT NULL,
  detail          JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- (at DESC, id DESC) supports keyset pagination: the feed is unbounded now, so
-- it must be paged rather than returned whole.
CREATE INDEX incidents_feed_idx ON incidents (at DESC, id DESC);

