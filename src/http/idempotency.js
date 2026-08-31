// Signal Zero — idempotency keys on the three routes that change something.
//
// ===========================================================================
// THIS IS AN INDUSTRY CONVENTION, NOT A STANDARD. BE PRECISE ABOUT THAT.
// ===========================================================================
// The `Idempotency-Key` header is a de-facto convention led by Stripe
// (https://docs.stripe.com/api/idempotent_requests) and adopted by most payment
// and provisioning APIs since.
//
// There IS an IETF draft, `draft-ietf-httpapi-idempotency-key-header`
// (https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
// and it is EXPIRED AND ARCHIVED. It never became an RFC. Calling this
// implementation "RFC-compliant" or "standards-compliant" would be wrong, and
// wrong in the specific way that is easy to check — so this file says what it
// implements: Stripe's semantics, deliberately, because they are the ones every
// client library already expects.
//
// (Contrast RFC 9457 in src/http/problem.js, which IS a published standard and is
// cited by number there. The difference between the two is the whole point of
// being careful about the wording.)
//
// ===========================================================================
// WHY THIS IS A CORRECTNESS FIX AND NOT A NICETY
// ===========================================================================
// `POST /api/checkpoint/{id}/approve` records a NAMED HUMAN's signed decision on
// a safety control, into an append-only log. A double-clicked button, a client
// retry after a timeout, or a proxy replay writes a second decision — or, before
// this, collided with a 409 that the caller could not distinguish from "somebody
// else got here first".
//
// In an auditability product that is a real correctness bug, not a theoretical
// one: the whole claim is that a human decision is legible after the fact, and
// two rows for one click is not legible.
//
// The same key applied to POST /api/run stops a double-clicked "Run pipeline"
// from queueing a second pass behind the first.
//
// ===========================================================================
// THE SEMANTICS, EXACTLY
// ===========================================================================
//   no header                     the route runs normally. Keys are OPTIONAL,
//                                 as they are at Stripe.
//   key + same request, first     the route runs; status and body are stored.
//   key + same request, again     the STORED RESPONSE is replayed byte for byte,
//                                 with `Idempotent-Replayed: true`. The route
//                                 does not run.
//   key + different request       409 idempotency-key-reuse. A key identifies one
//                                 request; replaying a stored answer to a
//                                 different question would be worse than an error.
//   key + first still in flight   409 idempotency-key-in-flight. There is nothing
//                                 to replay yet, and running a second copy is
//                                 precisely the double-submission the key exists
//                                 to prevent.
//
// "Same request" means same method, same path, and same body — compared by SHA-256
// over a CANONICAL JSON encoding (object keys sorted), so `{"a":1,"b":2}` and
// `{"b":2,"a":1}` are correctly one request rather than two. Comparing raw bytes
// would make key-order-dependent clients fail for no reason.
//
// 5xx RESPONSES ARE NOT STORED. Stripe does not save results for server errors,
// and it is right not to: the point of retrying with the same key is to recover
// from exactly that case, and a cached 500 would make the failure permanent. The
// record is dropped instead, so a retry executes.
//
// ===========================================================================
// WHERE THE RECORDS LIVE, AND THE LIMIT THAT COMES WITH IT
// ===========================================================================
// IN THIS PROCESS'S MEMORY. Not in Postgres. That is a real limitation and it is
// stated plainly here, in `openapi.yaml`, and on the `Idempotency-Key` response
// contract rather than left for someone to discover:
//
//   * A restart forgets every key. A retry after a restart RE-EXECUTES.
//   * Two processes behind a load balancer do not share keys.
//
// Making it durable needs a table, which needs a numbered migration, which is
// owned by the schema change this work sits on top of rather than by the HTTP
// layer. It is the obvious next step and it is not pretended to be done.
//
// The failure mode of forgetting a key is bounded, and that is why in-memory was
// acceptable rather than blocking:
//
//   * A forgotten approve key re-executes and meets `ALREADY_DECIDED` (409). The
//     append-only log is NOT double-written — the checkpoint's own guard holds.
//     The caller gets a worse error, never a second signature.
//   * A forgotten run key re-executes and meets the single-flight guard, or
//     starts one more pipeline pass, which is idempotent in effect: a pass
//     recomputes derived projections and appends observations that the silence
//     clock reads as repeat sightings of the same reports.
//
// So the key layer is defence in depth over guards that already exist. It is
// never the only thing standing between a click and a duplicate decision.

import { createHash } from 'node:crypto';

import { ProblemError } from './problem.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAY_HEADER = 'Idempotent-Replayed';

/** Stripe keeps keys for at least 24 hours. So does this. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A ceiling on how many records this process holds.
 *
 * Bounding this is NOT the ring-buffer mistake the incident feed made. An
 * incident is a fact about the world and dropping one destroys evidence; an
 * idempotency record is a response cache whose loss degrades to re-execution,
 * and re-execution is caught by the guards named in the header. The oldest
 * COMPLETE records are evicted first, and an in-flight record is never evicted —
 * evicting one would let its twin execute concurrently, which is the one outcome
 * this file exists to prevent.
 */
export const MAX_RECORDS = 1000;

/** Keys are a single line of printable ASCII, at most this long. */
export const KEY_MAX_LENGTH = 255;

/** @type {Map<string, {fingerprint:string, method:string, path:string, state:'in-flight'|'complete', createdAt:number, status:number|null, contentType:string|null, body:string|null}>} */
const records = new Map();

/** Object keys sorted at every depth, so key order is not part of the identity. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function fingerprintOf(req) {
  // The path WITHOUT the query string: no route here takes a meaningful query,
  // and including one would make `?t=1` a different request from `?t=2` for
  // clients that cache-bust, which is the opposite of what a retry wants.
  const path = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
  return createHash('sha256')
    .update(`${req.method}\n${path}\n${canonicalJson(req.body ?? null)}`)
    .digest('hex');
}

/** Drop expired records, then the oldest complete ones if still over the cap. */
function prune(now = Date.now()) {
  for (const [key, rec] of records) {
    if (rec.state === 'complete' && now - rec.createdAt > RETENTION_MS) records.delete(key);
  }
  if (records.size <= MAX_RECORDS) return;
  const evictable = [...records.entries()]
    .filter(([, rec]) => rec.state === 'complete')
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  let over = records.size - MAX_RECORDS;
  for (const [key] of evictable) {
    if (over <= 0) break;
    records.delete(key);
    over -= 1;
  }
}

/**
 * Validate the header. Returns null when absent — keys are optional.
 * @throws {ProblemError} 400 invalid-idempotency-key
 */
function readKey(req) {
  const raw = req.get(IDEMPOTENCY_HEADER);
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim();
  if (key === '') {
    throw new ProblemError(
      'invalid-idempotency-key',
      'Idempotency-Key was present but empty. Omit the header entirely, or send a key.'
    );
  }
  if (key.length > KEY_MAX_LENGTH) {
    throw new ProblemError(
      'invalid-idempotency-key',
      `Idempotency-Key must be at most ${KEY_MAX_LENGTH} characters; received ${key.length}.`,
      { maximumLength: KEY_MAX_LENGTH }
    );
  }
  // Printable ASCII only. A key with a newline in it is a header-splitting
  // attempt or a client bug, and neither should be echoed back into a response.
  if (!/^[\x20-\x7e]+$/.test(key)) {
    throw new ProblemError(
      'invalid-idempotency-key',
      'Idempotency-Key must be a single line of printable ASCII characters.'
    );
  }
  return key;
}

/**
 * Express middleware implementing the semantics in the header.
 *
 * Mount it on a route, not globally: a GET is already idempotent and giving it a
 * key would cache reads, which is a different feature with different failure
 * modes and is not what this is.
 */
export function idempotency() {
  return function idempotencyMiddleware(req, res, next) {
    let key;
    try {
      key = readKey(req);
    } catch (err) {
      if (err instanceof ProblemError) return next(err);
      throw err;
    }
    if (key === null) return next();

    prune();

    const fingerprint = fingerprintOf(req);
    const existing = records.get(key);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return next(
          new ProblemError(
            'idempotency-key-reuse',
            `Idempotency-Key "${key}" was already used for a different request ` +
              `(${existing.method} ${existing.path}). A key identifies one request; use a fresh ` +
              'key for a different one.',
            { idempotencyKey: key, firstSeenAt: new Date(existing.createdAt).toISOString() }
          )
        );
      }
      if (existing.state === 'in-flight') {
        return next(
          new ProblemError(
            'idempotency-key-in-flight',
            `The first request carrying Idempotency-Key "${key}" has not finished yet, so ` +
              'there is no stored response to replay. Retry once it answers.',
            { idempotencyKey: key, firstSeenAt: new Date(existing.createdAt).toISOString() }
          )
        );
      }
      // REPLAY. The stored bytes, the stored status, the stored content type.
      res.set(REPLAY_HEADER, 'true');
      res.set('Idempotency-Key', key);
      res.status(existing.status ?? 200);
      if (existing.contentType) res.type(existing.contentType);
      return res.send(existing.body ?? '');
    }

    const path = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
    records.set(key, {
      fingerprint,
      method: req.method,
      path,
      state: 'in-flight',
      createdAt: Date.now(),
      status: null,
      contentType: null,
      body: null
    });

    res.set('Idempotency-Key', key);
    res.set(REPLAY_HEADER, 'false');

    // Capture at res.send rather than res.json: express's res.json calls
    // res.send, and the problem-details responses go through res.type().json()
    // too, so one hook covers both — and it stores the SERIALISED BYTES, which
    // makes a replay byte-identical rather than a re-serialisation that might
    // differ in key order.
    const originalSend = res.send.bind(res);
    res.send = (body) => {
      const rec = records.get(key);
      if (rec && rec.state === 'in-flight') {
        if (res.statusCode >= 500) {
          // NOT stored. See the header: a cached 500 makes a transient failure
          // permanent, and recovering from it is the reason to retry with a key.
          records.delete(key);
        } else {
          rec.state = 'complete';
          rec.status = res.statusCode;
          rec.contentType = res.get('Content-Type') ?? null;
          rec.body = typeof body === 'string' ? body : JSON.stringify(body ?? null);
        }
      }
      return originalSend(body);
    };

    // A request that never reaches res.send — the socket dies, the process is
    // shutting down — must not leave a permanent in-flight record that answers
    // 409 forever. `close` fires either way.
    res.on('close', () => {
      const rec = records.get(key);
      if (rec && rec.state === 'in-flight') records.delete(key);
    });

    next();
  };
}

/** How many records this process is holding. For tests and for honesty. */
export function idempotencyRecordCount() {
  return records.size;
}

/** Test seam. */
export function resetIdempotencyForTests() {
  records.clear();
}

export default {
  IDEMPOTENCY_HEADER,
  KEY_MAX_LENGTH,
  MAX_RECORDS,
  REPLAY_HEADER,
  RETENTION_MS,
  idempotency,
  idempotencyRecordCount,
  resetIdempotencyForTests
};
