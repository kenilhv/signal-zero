// Signal Zero — repository barrel.
//
// THE ONLY PLACE SQL LIVES is src/db/repositories/*.js. Nothing outside this
// directory writes a query string; callers import an aggregate from here and get
// plain JS objects shaped exactly like the ones src/store.js used to hold.
//
// Every repository function takes an optional trailing `db` argument (anything
// with `.query(text, params)`), so the same function works standalone or inside
// a caller's transaction:
//
//   import { withTransaction } from '../db/pool.js';
//   await withTransaction(async (tx) => {
//     await reports.replaceForRun(runId, reports, tx);
//     await ranked.replaceForRun(runId, rows, tx);
//   });

export * as checkpoint from './checkpoint.js';
export * as clusters from './clusters.js';
export * as incidents from './incidents.js';
export * as observations from './observations.js';
export * as ranked from './ranked.js';
export * as reports from './reports.js';
export * as runs from './runs.js';
export * as settlements from './settlements.js';
