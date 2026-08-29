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
  stats: {}
};

const MAX_INCIDENTS = 200;

let incidentSeq = 0;

/**
 * Push an IncidentEvent onto the fail feed and return it.
 * kind: 'degraded-source' | 'llm-fallback' | 'cold-start' | 'heal'
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
