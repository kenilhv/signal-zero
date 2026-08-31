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
const { rank, qualifiesForEscalation } = await import(new URL('../../src/pipeline/rank.js', import.meta.url));
const { createEscalation } = await import(new URL('../../src/pipeline/checkpoint.js', import.meta.url));
const { store } = await import(new URL('../../src/store.js', import.meta.url));

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
    createEscalation({
      settlementId: r.settlementId,
      title: `Anomalous silence: ${r.name}`,
      evidence: { settlementId: r.settlementId, silenceHours: r.silenceHours }
    });
  }
  stages.checkpointItems = store.checkpoint.length;
} catch (err) {
  threw = String(err && err.stack ? err.stack : err);
}

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      survived: threw === null,
      threw,
      stages,
      incidents: store.incidents.map((i) => ({ kind: i.kind, message: i.message, detail: i.detail }))
    },
    null,
    2
  )
);
console.log(`empty-ingest: survived=${threw === null} ranked=${stages.ranked ?? 0}`);
