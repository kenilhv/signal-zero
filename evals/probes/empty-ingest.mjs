// Child-process probe: run the pipeline stages in order with ZERO reports.
//
// This is the "the scraper came back with nothing" case. It is not an error - a
// connector can legitimately return no items - so the system must not crash, and
// must not fill the silence with invented confidence. The whole ranking is then
// derived from priors, and every single row has to say so.

import fs from 'node:fs';

process.env.TRUEFORGE_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.USE_LIVE_SCRAPE = 'false';

const outPath = process.argv[2];

const { triage } = await import(new URL('../../src/pipeline/triage.js', import.meta.url));
const { dedup } = await import(new URL('../../src/pipeline/dedup.js', import.meta.url));
const { rank, qualifiesForEscalation } = await import(
  new URL('../../src/pipeline/rank.js', import.meta.url)
);
const { createEscalation } = await import(
  new URL('../../src/pipeline/checkpoint.js', import.meta.url)
);
const { listCheckpoint } = await import(
  new URL('../../src/pipeline/checkpoint.js', import.meta.url)
);
const { recentIncidents, initBackend } = await import(
  new URL('../../src/store.js', import.meta.url)
);

// This probe runs against the NON-DURABLE store ON PURPOSE, and the choice is
// forced rather than inherited from whatever .env holds.
//
// What is being tested here is that an empty ingest does not crash the STAGES
// and does not manufacture confidence — a property of the pipeline, not of the
// storage, and one the two backends are required to agree on. Running it against
// the shared Postgres would additionally write checkpoint rows for real
// gazetteer ids into a database other eval scenarios read, which would make this
// probe's side effects somebody else's flaky test. The mode is recorded in the
// output so a reader of the report knows which store produced these numbers.
process.env.DATABASE_URL = '';
const persistenceMode = await initBackend({ logger: null });

const gazetteer = JSON.parse(
  fs.readFileSync(new URL('../../src/data/gazetteer.json', import.meta.url), 'utf8')
);
const corridor = JSON.parse(
  fs.readFileSync(new URL('../../src/data/corridor.json', import.meta.url), 'utf8')
);

const stages = {};
let threw = null;
try {
  const reports = [];
  stages.triage = (await triage(reports, gazetteer)).length;
  const d = dedup(reports, gazetteer);
  stages.clusters = d.clusters.length;
  stages.ambiguousPairs = d.ambiguousPairs.length;
  const ranked = rank(gazetteer, d.clusters, reports, new Date(), { adjacency: corridor });
  stages.ranked = ranked.length;
  stages.escalationCandidates = ranked.filter((r) => qualifiesForEscalation(r)).length;
  stages.coverageBases = [...new Set(ranked.map((r) => r.coverageBasis))];
  stages.corroborationTotal = ranked.reduce((s, r) => s + r.corroborationCount, 0);
  stages.lastReportAtAllNull = ranked.every((r) => r.lastReportAt === null);
  stages.lambdaRange = [
    Math.min(...ranked.map((r) => r.lambdaPerHour)),
    Math.max(...ranked.map((r) => r.lambdaPerHour))
  ];
  stages.fitBases = [...new Set(ranked.map((r) => r.fitBasis))];
  stages.sampleRow = ranked[0];
  for (const r of ranked.filter((x) => qualifiesForEscalation(x)).slice(0, 3)) {
    // Awaited: createEscalation writes to the store now. Without the await the
    // count below would race the writes and this probe would report zero
    // checkpoint items on a run that raised three.
    await createEscalation({
      settlementId: r.settlementId,
      title: `Anomalous silence: ${r.name}`,
      evidence: { settlementId: r.settlementId, silenceHours: r.silenceHours }
    });
  }
  stages.checkpointItems = (await listCheckpoint()).length;
} catch (err) {
  threw = String(err && err.stack ? err.stack : err);
}

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      survived: threw === null,
      threw,
      persistence: { mode: persistenceMode.mode, durable: persistenceMode.durable },
      stages,
      incidents: (await recentIncidents({ limit: 500 })).map((i) => ({
        kind: i.kind,
        message: i.message,
        detail: i.detail
      }))
    },
    null,
    2
  )
);
console.log(`empty-ingest: survived=${threw === null} ranked=${stages.ranked ?? 0}`);
