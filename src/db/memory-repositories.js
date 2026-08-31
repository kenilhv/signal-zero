// Signal Zero — the NON-DURABLE backend.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT A SHADOW COPY
//
// Exactly one backend is live per process. It is chosen once, at boot, in
// src/db/backend.js, and the choice is reported by GET /api/state. When Postgres
// is configured this file is never touched; when it is not, this file is the
// ONLY store and there is no database for it to disagree with. That is the
// distinction that matters: the failure mode to avoid is an in-memory copy
// running ALONGSIDE the database and silently drifting from it. Two stores, one
// truth, is a bug. One store, honestly labelled, is a mode.
//
// It implements the same function signatures as src/db/repositories/*.js so
// every caller upstream has exactly one code path. Where the SQL version relies
// on a database property, this version reproduces the property in JS and says so:
//
//   * latestPerSettlement() drives from the gazetteer, not from observations, so
//     a settlement nothing has ever resolved to still appears with
//     lastObservedAt === null. Same LEFT JOIN semantics, same hard rule 4.
//   * There is no `?? Date.now()` anywhere in this file. A missing timestamp
//     stays null here for the same reason it stays NULL there.
//   * appendMany validates every observedAt BEFORE writing any of them, so a bad
//     batch leaves the silence clock untouched rather than half-advanced.
//   * Nothing truncates the incident feed.
//
// WHAT IT CANNOT DO, AND SAYS SO
// It does not survive a restart. The silence clock measures time since the last
// observation, so in this mode the product's central claim is unverifiable — and
// `durable: false` in GET /api/state is how the operator finds that out rather
// than by discovering a reset clock during an incident.

import { requireIso, toIso } from './values.js';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function emptyTables() {
  return {
    settlements: new Map(), // id -> settlement
    observations: [], // append-only
    runs: new Map(), // runId -> run
    reports: new Map(), // runId -> Map(reportId -> report)
    clusters: new Map(), // runId -> Map(clusterId -> cluster)
    ranked: new Map(), // runId -> ranked[]
    checkpointItems: new Map(), // id -> item
    approvals: [], // append-only
    incidents: [], // append-only, unbounded
    nextObservationId: 1,
    nextApprovalId: 1
  };
}

let T = emptyTables();

/** Drop everything. Only a test harness should call this. */
export function reset() {
  T = emptyTables();
}

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

// ---------------------------------------------------------------------------
// settlements
// ---------------------------------------------------------------------------

export const settlements = {
  async upsertMany(list) {
    const items = Array.isArray(list) ? list : [];
    const out = [];
    for (const s of items) {
      const row = {
        id: String(s.id),
        name: String(s.name ?? ''),
        district: String(s.district ?? ''),
        lat: Number(s.lat),
        lon: Number(s.lon),
        population: Number(s.population ?? 0),
        hazardTier: Number(s.hazardTier ?? s.hazard_tier ?? 1),
        aliases: Array.isArray(s.aliases) ? s.aliases.slice() : []
      };
      T.settlements.set(row.id, row);
      out.push(clone(row));
    }
    return out;
  },
  async listAll() {
    return [...T.settlements.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone);
  },
  async getById(id) {
    return clone(T.settlements.get(String(id))) ?? null;
  },
  async count() {
    return T.settlements.size;
  }
};

// ---------------------------------------------------------------------------
// observations — append-only, the only input to the silence clock
// ---------------------------------------------------------------------------

function makeObservation(o) {
  return {
    observationId: T.nextObservationId++,
    settlementId: String(o.settlementId),
    // requireIso throws rather than guessing. A report whose time could not be
    // parsed gets NO row, exactly as in SQL.
    observedAt: requireIso(o.observedAt, 'observation.observedAt'),
    sourceName: String(o.sourceName ?? ''),
    sourceType: String(o.sourceType ?? ''),
    reportId: o.reportId ?? null,
    clusterId: o.clusterId ?? null,
    url: o.url ?? null,
    title: o.title ?? null,
    recordedAt: new Date().toISOString()
  };
}

export const observations = {
  async append(obs) {
    const row = makeObservation(obs);
    T.observations.push(row);
    return clone(row);
  },

  async appendMany(list) {
    const items = Array.isArray(list) ? list : [];
    if (items.length === 0) return [];
    // Validate the whole batch before writing any of it — partial credit for a
    // bad batch would leave the silence clock half-advanced.
    items.forEach((o, i) => {
      requireIso(o.observedAt, `observations[${i}].observedAt`);
    });
    const rows = items.map(makeObservation);
    T.observations.push(...rows);
    return rows.map(clone);
  },

  /**
   * One row per gazetteer settlement, newest observation attached.
   * Drives from `settlements`, so a settlement with no observations is PRESENT
   * with lastObservedAt === null — never absent, never backfilled.
   */
  async latestPerSettlement() {
    const newest = new Map();
    for (const o of T.observations) {
      const prev = newest.get(o.settlementId);
      if (!prev || o.observedAt > prev.observedAt) newest.set(o.settlementId, o);
    }
    return [...T.settlements.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => {
        const o = newest.get(s.id) ?? null;
        return {
          settlementId: s.id,
          name: s.name,
          district: s.district,
          // NULL means NO REPORT HAS EVER RESOLVED HERE.
          lastObservedAt: o ? o.observedAt : null,
          observationId: o ? o.observationId : null,
          sourceName: o ? o.sourceName : null,
          sourceType: o ? o.sourceType : null,
          reportId: o ? o.reportId : null,
          clusterId: o ? o.clusterId : null,
          url: o ? o.url : null,
          title: o ? o.title : null,
          recordedAt: o ? o.recordedAt : null
        };
      });
  },

  async latestForSettlement(settlementId) {
    const all = await observations.latestPerSettlement();
    return all.find((r) => r.settlementId === String(settlementId)) ?? null;
  },

  async listForSettlement(settlementId, { limit = 500 } = {}) {
    const id = String(settlementId);
    return T.observations
      .filter((o) => o.settlementId === id)
      .sort((a, b) =>
        a.observedAt === b.observedAt
          ? b.observationId - a.observationId
          : a.observedAt < b.observedAt
            ? 1
            : -1
      )
      .slice(0, Math.max(1, Math.min(10_000, Number(limit) || 500)))
      .map(clone);
  },

  /** Every observation, oldest first. The baseline fit needs the gaps. */
  async listAll({ limit = 100_000 } = {}) {
    return T.observations
      .slice()
      .sort((a, b) =>
        a.observedAt === b.observedAt
          ? a.observationId - b.observationId
          : a.observedAt < b.observedAt
            ? -1
            : 1
      )
      .slice(0, Math.max(1, Number(limit) || 100_000))
      .map(clone);
  },

  async count() {
    return T.observations.length;
  }
};

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export const runs = {
  async start(runId) {
    const id = String(runId);
    const existing = T.runs.get(id);
    const row = existing
      ? { ...existing, status: 'running' }
      : {
          runId: id,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          durationMs: null,
          status: 'running',
          error: null,
          stats: {}
        };
    T.runs.set(id, row);
    return clone(row);
  },

  async finish(runId, { durationMs = null, stats = {} } = {}) {
    const row = T.runs.get(String(runId));
    if (!row) return null;
    row.status = 'done';
    row.finishedAt = new Date().toISOString();
    row.durationMs = durationMs === null ? null : Math.trunc(Number(durationMs));
    row.stats = clone(stats) ?? {};
    return clone(row);
  },

  async fail(runId, error, { durationMs = null, stats = {} } = {}) {
    const row = T.runs.get(String(runId));
    if (!row) return null;
    row.status = 'error';
    row.finishedAt = new Date().toISOString();
    row.durationMs = durationMs === null ? null : Math.trunc(Number(durationMs));
    row.error = error === null || error === undefined ? null : String(error?.message ?? error);
    row.stats = clone(stats) ?? {};
    return clone(row);
  },

  async getById(runId) {
    return clone(T.runs.get(String(runId))) ?? null;
  },

  async latest() {
    const all = [...T.runs.values()].sort((a, b) =>
      a.startedAt === b.startedAt
        ? b.runId.localeCompare(a.runId)
        : a.startedAt < b.startedAt
          ? 1
          : -1
    );
    return all.length ? clone(all[0]) : null;
  },

  async latestCompleted() {
    const all = [...T.runs.values()]
      .filter((r) => r.status === 'done' && r.finishedAt)
      .sort((a, b) =>
        a.finishedAt === b.finishedAt
          ? b.runId.localeCompare(a.runId)
          : a.finishedAt < b.finishedAt
            ? 1
            : -1
      );
    return all.length ? clone(all[0]) : null;
  },

  async list({ limit = 50 } = {}) {
    const all = [...T.runs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return all.slice(0, Math.max(1, Number(limit) || 50)).map(clone);
  },

  /** `{}` when no pass has ever finished — not a zero-filled object. */
  async latestStats() {
    const run = await runs.latestCompleted();
    if (!run) return {};
    return { ...run.stats, lastRunAt: run.finishedAt, durationMs: run.durationMs };
  }
};

// ---------------------------------------------------------------------------
// reports / clusters / ranked — derived per run, replaced wholesale
// ---------------------------------------------------------------------------

export const reports = {
  async replaceForRun(runId, list) {
    const id = String(runId);
    const table = new Map();
    for (const r of Array.isArray(list) ? list : []) {
      table.set(String(r.id), {
        id: String(r.id),
        sourceType: r.sourceType ?? null,
        sourceName: r.sourceName ?? null,
        url: r.url ?? null,
        title: r.title ?? null,
        text: r.text ?? null,
        publishedAt: toIso(r.publishedAt),
        fetchedAt: toIso(r.fetchedAt),
        settlementId: r.settlementId ?? null,
        triage: clone(r.triage) ?? null,
        clusterId: r.clusterId ?? null
      });
    }
    T.reports.set(id, table);
    return [...table.values()].map(clone);
  },
  async listForRun(runId) {
    const table = T.reports.get(String(runId));
    return table ? [...table.values()].map(clone) : [];
  },
  async listForSettlement(runId, settlementId) {
    return (await reports.listForRun(runId)).filter((r) => r.settlementId === String(settlementId));
  },
  async getById(runId, reportId) {
    const table = T.reports.get(String(runId));
    return table ? (clone(table.get(String(reportId))) ?? null) : null;
  },
  async countForRun(runId) {
    return T.reports.get(String(runId))?.size ?? 0;
  }
};

export const clusters = {
  async replaceForRun(runId, list) {
    const id = String(runId);
    const table = new Map();
    for (const c of Array.isArray(list) ? list : []) {
      const memberIds = Array.isArray(c.reportIds) ? c.reportIds.slice() : [];
      table.set(String(c.id), {
        id: String(c.id),
        settlementId: c.settlementId ?? null,
        reportIds: memberIds,
        confidence:
          c.confidence === null || c.confidence === undefined ? null : Number(c.confidence),
        sourceTypeDiversity: Number(c.sourceTypeDiversity ?? 0)
      });
    }
    T.clusters.set(id, table);
    return [...table.values()].map(clone);
  },
  async listForRun(runId) {
    const table = T.clusters.get(String(runId));
    return table ? [...table.values()].map(clone) : [];
  },
  async getById(runId, clusterId) {
    const table = T.clusters.get(String(runId));
    return table ? (clone(table.get(String(clusterId))) ?? null) : null;
  },
  async listForSettlement(runId, settlementId) {
    const id = String(settlementId);
    const rs = await reports.listForRun(runId);
    const clusterIds = new Set(rs.filter((r) => r.settlementId === id).map((r) => r.clusterId));
    return (await clusters.listForRun(runId)).filter(
      (c) => c.settlementId === id || clusterIds.has(c.id)
    );
  }
};

export const ranked = {
  async replaceForRun(runId, list) {
    const id = String(runId);
    const rows = (Array.isArray(list) ? list : []).map((r, i) => ({
      ...clone(r),
      rank: Number(r.rank ?? i + 1),
      // The rename that SQL does in ranked.js happens here too, and it is a
      // rename, never a fill: null stays null.
      lastReportAt: toIso(r.lastReportAt)
    }));
    rows.sort((a, b) => a.rank - b.rank);
    T.ranked.set(id, rows);
    return rows.map(clone);
  },
  async listForRun(runId) {
    return (T.ranked.get(String(runId)) ?? []).map(clone);
  },
  async getForRun(runId, settlementId) {
    const row = (T.ranked.get(String(runId)) ?? []).find(
      (r) => r.settlementId === String(settlementId)
    );
    return clone(row) ?? null;
  },
  async listLatest() {
    const run = await runs.latestCompleted();
    return run ? ranked.listForRun(run.runId) : [];
  }
};

// ---------------------------------------------------------------------------
// checkpoint + approvals — status is a PROJECTION of the append-only log
// ---------------------------------------------------------------------------

function latestApproval(itemId) {
  let best = null;
  for (const a of T.approvals) {
    if (a.itemId !== itemId) continue;
    if (
      !best ||
      a.decidedAt > best.decidedAt ||
      (a.decidedAt === best.decidedAt && a.approvalId > best.approvalId)
    ) {
      best = a;
    }
  }
  return best;
}

function projectItem(item) {
  const d = latestApproval(item.id);
  return {
    id: item.id,
    kind: item.kind,
    settlementId: item.settlementId,
    title: item.title,
    evidence: clone(item.evidence),
    provenance: clone(item.provenance),
    // Null until a named human has decided. Never a placeholder name.
    approvedBy: d ? d.approvedBy : null,
    decidedAt: d ? d.decidedAt : null,
    createdAt: item.createdAt,
    // The projection: recomputed from the log, never trusted from an argument.
    status: d ? d.decision : 'pending'
  };
}

export const checkpoint = {
  async create(item) {
    const id = String(item.id);
    if (!T.checkpointItems.has(id)) {
      T.checkpointItems.set(id, {
        id,
        runId: item.runId ?? null,
        kind: String(item.kind),
        settlementId: item.settlementId ?? null,
        title: String(item.title ?? ''),
        evidence: clone(item.evidence) ?? {},
        provenance: clone(item.provenance) ?? {},
        createdAt: new Date().toISOString()
      });
    }
    return projectItem(T.checkpointItems.get(id));
  },

  async getById(id) {
    const item = T.checkpointItems.get(String(id));
    return item ? projectItem(item) : null;
  },

  async list(filter = {}) {
    let items = [...T.checkpointItems.values()].map(projectItem);
    if (filter.status) items = items.filter((i) => i.status === filter.status);
    if (filter.kind) items = items.filter((i) => i.kind === filter.kind);
    if (filter.settlementId) items = items.filter((i) => i.settlementId === filter.settlementId);
    return items.sort((a, b) =>
      a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : a.createdAt < b.createdAt ? 1 : -1
    );
  },

  async countPending() {
    return (await checkpoint.list({ status: 'pending' })).length;
  },

  /**
   * Append to the decision log, then reproject.
   *
   * The blank-name rule lives in the database as a NOT NULL + non-blank CHECK.
   * There is no database here, so it is restated as an explicit throw carrying
   * the same SQLSTATE-ish shape — NOT skipped, and NOT quietly relaxed, because
   * "nothing is actionable without a named human" is hard rule 2 and it does not
   * get to be weaker just because durability is.
   */
  async decide({ id, decision, approvedBy, shortlist = null }) {
    const item = T.checkpointItems.get(String(id));
    if (!item) return null;
    const name = approvedBy === null || approvedBy === undefined ? '' : String(approvedBy).trim();
    if (name === '') {
      const err = new Error(
        'new row for relation "approvals" violates check constraint "approvals_approved_by_check"'
      );
      err.code = '23514';
      throw err;
    }
    T.approvals.push({
      approvalId: T.nextApprovalId++,
      itemId: item.id,
      decision: String(decision),
      approvedBy: name,
      decidedAt: new Date().toISOString(),
      shortlist: clone(shortlist)
    });
    return projectItem(item);
  },

  async listDecisions(id) {
    return T.approvals
      .filter((a) => a.itemId === String(id))
      .sort((a, b) => a.approvalId - b.approvalId)
      .map(clone);
  }
};

// ---------------------------------------------------------------------------
// incidents — append-only, NOTHING TRUNCATES
// ---------------------------------------------------------------------------
// There is no MAX_INCIDENTS in this file either. The 200-item ring buffer this
// replaces dropped the 201st failure on the one surface whose job is making
// failure visible, and moving that buffer into a "fallback mode" would just be
// hiding it somewhere less visible. The READ is paged; the WRITE is unbounded.

export const incidents = {
  async append(kind, message, detail = {}, opts = {}) {
    const row = {
      id: String(opts.id ?? `inc-${Date.now().toString(36)}-${T.incidents.length.toString(36)}`),
      runId: opts.runId ?? null,
      at: toIso(opts.at) ?? new Date().toISOString(),
      kind: String(kind),
      message: String(message),
      detail: clone(detail) ?? {}
    };
    T.incidents.push(row);
    return { id: row.id, at: row.at, kind: row.kind, message: row.message, detail: row.detail };
  },

  async list({ limit, cursor = null, kind, runId } = {}) {
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    let rows = T.incidents
      .slice()
      .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : a.at < b.at ? 1 : -1));
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (runId) rows = rows.filter((r) => r.runId === runId);
    const parsed = incidents.parseCursor(cursor);
    if (parsed) {
      rows = rows.filter((r) => r.at < parsed.at || (r.at === parsed.at && r.id < parsed.id));
    }
    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        at: r.at,
        kind: r.kind,
        message: r.message,
        detail: clone(r.detail)
      })),
      nextCursor: hasMore && last ? incidents.encodeCursor(last.at, last.id) : null,
      hasMore
    };
  },

  encodeCursor(at, id) {
    const iso = toIso(at);
    return iso === null ? null : `${iso}|${id}`;
  },

  parseCursor(cursor) {
    if (!cursor) return null;
    if (typeof cursor === 'object') {
      const at = toIso(cursor.at);
      return at && cursor.id ? { at, id: String(cursor.id) } : null;
    }
    const s = String(cursor);
    const sep = s.lastIndexOf('|');
    if (sep < 0) return null;
    const at = toIso(s.slice(0, sep));
    const id = s.slice(sep + 1);
    return at && id ? { at, id } : null;
  },

  async getById(id) {
    const r = T.incidents.find((x) => x.id === String(id));
    return r
      ? { id: r.id, at: r.at, kind: r.kind, message: r.message, detail: clone(r.detail) }
      : null;
  },

  async count({ kind } = {}) {
    return kind ? T.incidents.filter((r) => r.kind === kind).length : T.incidents.length;
  }
};

export default {
  settlements,
  observations,
  runs,
  reports,
  clusters,
  ranked,
  checkpoint,
  incidents,
  reset
};
