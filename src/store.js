// Signal Zero - single in-memory store. No database.
// Everything here is rebuilt from scratch by a pipeline run, except `incidents`
// and `checkpoint` decisions, which are the human-facing audit trail.

export const store = {
  reports: [],
  clusters: [],
  settlements: [],
  ranked: [],
  checkpoint: [],
  incidents: [],
  sources: {},
  // TrueForge agent-harness telemetry for the last pipeline pass. Written by
  // triage tier 3 (the only stage that uses the harness) and read verbatim by
  // GET /api/state. Counters here are the ONLY thing the UI may use to claim a
  // classification was executed by the harness rather than by the fallback.
  harness: null,
  stats: {}
};

const MAX_INCIDENTS = 200;

let incidentSeq = 0;

/**
 * Push an IncidentEvent onto the fail feed and return it.
 * kind: 'degraded-source' | 'llm-fallback' | 'cold-start' | 'heal' | 'agent-refusal'
 */
export function addIncident(kind, message, detail = {}) {
  const event = {
    id: `inc-${Date.now().toString(36)}-${(incidentSeq++).toString(36)}`,
    at: new Date().toISOString(),
    kind,
    message,
    detail
  };
  store.incidents.unshift(event);
  if (store.incidents.length > MAX_INCIDENTS) {
    store.incidents.length = MAX_INCIDENTS;
  }
  return event;
}

export default store;
