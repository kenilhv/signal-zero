// Is the TrueForge harness actually there?
//
// WHY THIS IS A SHARED MODULE AND NOT A LOCAL HELPER. It is asked twice per run
// and the two answers are compared against each other:
//
//   run.js       asks ONCE, before any family starts, and passes the answer down
//                as `harnessReachable`.
//   family C     asks AGAIN if the adversarial probe fails, to tell "the model
//                answered badly" (a finding about the product) from "the model
//                was taken away" (a finding about the machine).
//
// That comparison is only meaningful if both calls mean the same thing by
// "reachable". Two copies of this function would drift - the second one would
// end up laxer, because the pressure when writing it is to explain away a
// failure - and the eval would start reporting infrastructure loss as a clean
// run. So there is one definition, here, and both callers import it.
//
// "Reachable" deliberately includes MODEL REGISTRATION, not just a TCP connect.
// TrueForge state lives in the container's SQLite and does not survive a
// recreation: an answering server with no registered agent is a server that
// cannot run a single case, and calling that "reachable" would push the failure
// one layer down to somewhere much harder to read.

export const DEFAULT_MODEL = 'nebius/signal-zero-triage';

/**
 * @param {string} url        base url, no trailing slash
 * @param {object} [opts]
 * @param {boolean} [opts.offline]  short-circuit to unreachable (--offline)
 * @param {string}  [opts.model]    model that must be registered
 * @param {number}  [opts.timeoutMs]
 * @returns {Promise<{reachable: boolean, reason: string|null, models?: string[]}>}
 */
export async function probeTrueforge(url, opts = {}) {
  const { offline = false, model, timeoutMs = 4000 } = opts;
  if (offline) return { reachable: false, reason: '--offline' };
  const want = model || process.env.EVAL_TRUEFORGE_MODEL || DEFAULT_MODEL;
  try {
    const res = await fetch(`${url}/api/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const models = (json?.data || []).map((m) => m?.name).filter(Boolean);
    if (!models.includes(want)) {
      return {
        reachable: false,
        reason: `model "${want}" not registered (have: ${models.join(', ') || 'none'})`,
        models
      };
    }
    return { reachable: true, reason: null, models };
  } catch (err) {
    return { reachable: false, reason: String(err.message || err) };
  }
}
