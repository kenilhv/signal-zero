// Signal Zero — RFC 9457 Problem Details for HTTP APIs.
//
// https://www.rfc-editor.org/rfc/rfc9457.html — which OBSOLETES RFC 7807. If you
// are reaching for `application/problem+json` in 2026, 9457 is the number.
//
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES, AND WHY IT IS NOT COSMETIC
// ---------------------------------------------------------------------------
// Before this file the API had three error envelopes and no way to tell them
// apart programmatically:
//
//   {ok:false, error}                       most routes
//   {ok:false, error, code}                 the checkpoint decisions
//   {ok:false, error, reportCount, durationMs}   the POST /api/run 409
//
// A client that wanted to branch on a failure had a human-readable English
// sentence to regex against, which means every error message was load-bearing
// prose that could not be reworded without breaking somebody. `openapi.yaml`
// wrote that down as INCONSISTENCY (2) rather than smoothing it over, precisely
// so this change would be a measurable diff against a real before-picture.
//
// Now there is ONE envelope, it is a standard one, and `type` is the stable
// machine-readable identity. The English is free to change.
//
// ---------------------------------------------------------------------------
// THE `type` URI, AND THE PART MOST IMPLEMENTATIONS SKIP
// ---------------------------------------------------------------------------
// RFC 9457 §3.1.1: the type URI "SHOULD" resolve to human-readable documentation
// when dereferenced. Almost every implementation emits a URI that 404s, which
// turns a SHOULD into decoration.
//
// So these dereference. `GET /problems` lists the registry and `GET /problems/{slug}`
// returns the entry — served by this module's own router, from the same table the
// error responses are built from, so the documentation cannot drift from the
// thing it documents. They are RELATIVE references (`/problems/approver-required`),
// resolved by the client against the server origin, because Signal Zero has no
// public domain to hang absolute URIs off and inventing one would be a URI that
// resolves to nothing on purpose.
//
// ---------------------------------------------------------------------------
// THE FOUR HARD RULES APPLY TO ERROR PROSE TOO
// ---------------------------------------------------------------------------
// Every title and detail below is scanned by the same no-dispatch vocabulary as
// the rest of the surface (hard rule 1), so none of them uses send / dispatch /
// deploy / assign / allocate in a prescriptive construction. And none of them
// substitutes a value for something the server does not know (hard rule 4): a
// problem document reports what failed, never a guess at what the caller meant.

import express from 'express';

/** The media type. RFC 9457 §3. Charset is implied by JSON and is not appended. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Where the `type` URIs point, and where the registry router is mounted. */
export const PROBLEM_BASE_PATH = '/problems';

/**
 * THE REGISTRY.
 *
 * One entry per failure this API can produce. `status` is the status code that
 * entry always carries — a `type` that means two different status codes is a
 * `type` a client cannot branch on, so there is exactly one per entry.
 *
 * `code` is an EXTENSION MEMBER kept for one specific reason: the checkpoint
 * errors already carried machine-readable codes (`APPROVER_REQUIRED`,
 * `ALREADY_DECIDED`, …) that are thrown from src/pipeline/checkpoint.js and
 * asserted on by the eval suite at the unit level. Dropping them would have
 * forced a rename inside the pipeline to satisfy a change to the HTTP layer.
 * They are carried through, not invented.
 */
export const PROBLEMS = Object.freeze({
  'approver-required': {
    status: 400,
    code: 'APPROVER_REQUIRED',
    title: 'A named human approver is required',
    doc:
      'HARD RULE 2. `approvedBy` was absent, was not a string, or was empty or ' +
      'whitespace-only. Nothing in Signal Zero becomes actionable anonymously. ' +
      'This is enforced in application code AND by a NOT NULL + non-blank CHECK ' +
      'on approvals.approved_by, so the same request fails twice over.'
  },
  'dispatch-field-forbidden': {
    status: 400,
    code: 'DISPATCH_FIELD_FORBIDDEN',
    title: 'Dispatch-shaped field is not allowed',
    doc:
      'HARD RULE 1. Checkpoint evidence carried a key naming an operational ' +
      'instruction. Signal Zero ranks silence; it never names where anyone ought ' +
      'to go. No such field exists anywhere in this API and none may be stored.'
  },
  'checkpoint-not-found': {
    status: 404,
    code: 'NOT_FOUND',
    title: 'No such checkpoint item',
    doc:
      'No held item has that id. Note the ordering: the named-approver check runs ' +
      'BEFORE the lookup, so a blank approver against an unknown id answers 400, ' +
      'not 404.'
  },
  'checkpoint-already-decided': {
    status: 409,
    code: 'ALREADY_DECIDED',
    title: 'Checkpoint item was already decided',
    doc:
      'A human already signed this item. The decision log is append-only and a ' +
      "second caller may not overwrite the first human's signature. To make a " +
      'repeated submission safe, send an `Idempotency-Key` header: the same key ' +
      'with the same body replays the original response instead of colliding.'
  },
  'checkpoint-status-immutable': {
    status: 409,
    code: 'STATUS_IMMUTABLE',
    title: 'Checkpoint status is read-only',
    doc:
      'Something attempted to write `item.status` directly rather than going ' +
      'through approve()/reject(). Status is a projection of the append-only ' +
      'approvals log and has no setter.'
  },
  'settlement-not-found': {
    status: 404,
    title: 'No such settlement',
    doc:
      'Neither the gazetteer nor the latest ranked snapshot knows that id. Either ' +
      'half alone may legitimately be missing; only when both are does this answer.'
  },
  'pipeline-run-in-flight': {
    status: 409,
    code: 'RUN_IN_FLIGHT',
    title: 'A pipeline pass is already running',
    doc:
      'The pipeline is single-flight per process. The in-flight run id is on the ' +
      '`runId` member; read its progress from GET /api/state under `run`. A repeat ' +
      'submission carrying the same `Idempotency-Key` as the request that started ' +
      'the pass replays that 202 instead of answering 409.'
  },
  'pipeline-run-failed': {
    status: 500,
    code: 'RUN_FAILED',
    title: 'The pipeline pass could not be started',
    doc:
      'The failure happened before the pass was accepted, so no run id exists. A ' +
      'failure DURING a pass does not appear here — it is reported on the fail ' +
      'feed and on GET /api/state under `run.status = "error"`, because by then ' +
      'the caller already holds a 202 and a run id.'
  },
  'unknown-failure-kind': {
    status: 400,
    code: 'UNKNOWN_FAILURE_KIND',
    title: 'Unknown demo failure kind',
    doc: 'The path segment did not name a simulator. Use source, ambiguous or coldstart.'
  },
  'invalid-page-size': {
    status: 400,
    code: 'INVALID_PAGE_SIZE',
    title: 'Page size is out of range',
    doc:
      'The requested page size was not a positive integer, or exceeded the ' +
      'documented maximum. The request is REFUSED rather than silently clamped: a ' +
      'client that asked for 5000 rows and received 500 without being told has ' +
      'been given a page it cannot distinguish from a complete answer. The limit ' +
      'and the maximum are on the `requested` and `maximum` members.'
  },
  'invalid-cursor': {
    status: 400,
    code: 'INVALID_CURSOR',
    title: 'Pagination cursor is not readable',
    doc:
      'A cursor is `<ISO 8601 instant>|<row id>` and is only ever produced by this ' +
      'API as `nextCursor`. It is not an offset and must not be constructed by ' +
      'hand. An unreadable cursor is refused rather than treated as "start from ' +
      'the beginning", which would silently re-serve page one.'
  },
  'invalid-idempotency-key': {
    status: 400,
    code: 'INVALID_IDEMPOTENCY_KEY',
    title: 'Idempotency-Key header is not usable',
    doc:
      'The header must be a single non-empty line of printable ASCII, at most 255 ' +
      'characters. A UUIDv4 is the usual choice.'
  },
  'idempotency-key-reuse': {
    status: 409,
    code: 'IDEMPOTENCY_KEY_REUSE',
    title: 'Idempotency-Key was already used with a different request',
    doc:
      'Stripe semantics: a key identifies ONE request. The key has already been ' +
      'seen on this server against a different method, path or body, so replaying ' +
      'the stored response would answer a question that was not asked. Use a fresh ' +
      'key for a different request.'
  },
  'idempotency-key-in-flight': {
    status: 409,
    code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    title: 'A request with this Idempotency-Key is still in flight',
    doc:
      'The first request carrying this key has not finished, so there is no stored ' +
      'response to replay yet and executing a second copy is the double-submission ' +
      'the key exists to prevent. Retry once the first request answers.'
  },
  'malformed-request-body': {
    status: 400,
    code: 'MALFORMED_BODY',
    title: 'Request body could not be parsed',
    doc: 'The body was not well-formed JSON, or exceeded the 1 MB parser limit.'
  },
  'route-not-found': {
    status: 404,
    code: 'NO_ROUTE',
    title: 'No such API route',
    doc:
      'No handler matches that method and path under /api. Non-API paths fall ' +
      'through to the static frontend instead and are not JSON.'
  },
  'internal-error': {
    status: 500,
    code: 'ERROR',
    title: 'Unhandled server error',
    doc:
      'Something threw and was not mapped to a specific problem type. The message ' +
      'is carried verbatim on `detail` and the failure is also written to the ' +
      'incident feed, because a failure the operator cannot see is the one failure ' +
      'this feed may not have.'
  }
});

/**
 * An error that already knows what problem document it becomes.
 *
 * Thrown by the HTTP layer and by src/http/* helpers. Anything else that throws
 * is mapped by `problemFromError` below, which never invents a type it does not
 * have — an unmapped throw becomes `internal-error`, honestly.
 */
export class ProblemError extends Error {
  /**
   * @param {keyof typeof PROBLEMS} slug
   * @param {string} detail  Human-readable, specific to THIS occurrence.
   * @param {object} [extensions]  Extra members merged into the document.
   */
  constructor(slug, detail, extensions = {}) {
    const entry = PROBLEMS[slug];
    if (!entry) throw new Error(`unknown problem type "${slug}"`);
    super(detail || entry.title);
    this.name = 'ProblemError';
    this.slug = slug;
    this.status = entry.status;
    this.statusCode = entry.status;
    this.code = entry.code ?? null;
    this.extensions = extensions;
  }
}

/** The `type` URI for a slug. A relative reference — see the header. */
export function problemType(slug) {
  return `${PROBLEM_BASE_PATH}/${slug}`;
}

/**
 * Build the problem document.
 *
 * `instance` is the request's own URL, which is what RFC 9457 §3.1.5 asks for:
 * a URI reference identifying THIS occurrence. It carries no personal data
 * because no route in this API takes any.
 */
export function buildProblem(slug, detail, { req = null, extensions = {} } = {}) {
  const entry = PROBLEMS[slug] ?? PROBLEMS['internal-error'];
  const resolved = PROBLEMS[slug] ? slug : 'internal-error';
  const doc = {
    type: problemType(resolved),
    title: entry.title,
    status: entry.status,
    detail: String(detail ?? entry.title)
  };
  if (req?.originalUrl) doc.instance = req.originalUrl;
  if (entry.code) doc.code = entry.code;
  // Extension members last so a route can add `runId`, `maximum`, … but they are
  // merged, never allowed to overwrite `status` — a document whose `status` and
  // whose HTTP status disagree is worse than no document (RFC 9457 §3.1.2).
  for (const [k, v] of Object.entries(extensions)) {
    if (k === 'status' || k === 'type') continue;
    doc[k] = v;
  }
  return doc;
}

/** Write a problem document as the response. Always `application/problem+json`. */
export function sendProblem(res, doc) {
  return res.status(doc.status).type(PROBLEM_CONTENT_TYPE).json(doc);
}

/** Build and send in one call. */
export function respondProblem(req, res, slug, detail, extensions = {}) {
  return sendProblem(res, buildProblem(slug, detail, { req, extensions }));
}

/**
 * Map ANY thrown value onto a problem document.
 *
 * The order matters and each branch exists for a real thrower:
 *   ProblemError      the HTTP layer's own, already typed.
 *   err.code          CheckpointError from src/pipeline/checkpoint.js, which
 *                     predates this file and keeps its own codes.
 *   err.status        express.json()'s parse and size failures, which set
 *                     `status` and `type` themselves.
 *   anything else     internal-error, with the message carried verbatim. It is
 *                     NOT relabelled as something more specific on a guess.
 */
export function problemFromError(err, req = null) {
  if (err instanceof ProblemError) {
    return buildProblem(err.slug, err.message, { req, extensions: err.extensions });
  }

  const byCode = CODE_TO_SLUG[err?.code];
  if (byCode) return buildProblem(byCode, err.message, { req });

  const status = Number(err?.status ?? err?.statusCode);
  if (status === 400 || status === 413) {
    return buildProblem('malformed-request-body', err?.message ?? 'Body could not be read', {
      req,
      // The 1 MB parser limit answers 413, and collapsing it into 400 would hide
      // which of the two happened. The document `type` is shared; the HTTP status
      // is not, and the handler in src/server.js keeps the 413.
      extensions: status === 413 ? { httpStatus: 413, limitExceeded: 'body-size' } : {}
    });
  }

  return buildProblem('internal-error', String(err?.message ?? err), { req });
}

/**
 * Codes thrown by code that is NOT part of the HTTP layer and must keep working
 * without importing it. src/pipeline/checkpoint.js throws CheckpointError with
 * these; the mapping lives here so the pipeline stays unaware of HTTP.
 */
const CODE_TO_SLUG = Object.freeze({
  APPROVER_REQUIRED: 'approver-required',
  DISPATCH_FIELD_FORBIDDEN: 'dispatch-field-forbidden',
  NOT_FOUND: 'checkpoint-not-found',
  ALREADY_DECIDED: 'checkpoint-already-decided',
  STATUS_IMMUTABLE: 'checkpoint-status-immutable'
});

/**
 * The registry, served. This is what makes the `type` URIs dereferenceable
 * rather than decorative — see the header.
 *
 * Deliberately NOT under /api: these are documentation, they are the same for
 * every deployment, and they must stay readable when the API itself is failing.
 */
export function problemRegistryRouter() {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({
      ok: true,
      specification: 'https://www.rfc-editor.org/rfc/rfc9457.html',
      mediaType: PROBLEM_CONTENT_TYPE,
      note:
        'Every error response from this API is a problem document with one of the ' +
        '`type` values below. `type` is the stable machine-readable identity; ' +
        '`title` and `detail` are prose and may be reworded.',
      problems: Object.entries(PROBLEMS).map(([slug, entry]) => ({
        type: problemType(slug),
        status: entry.status,
        title: entry.title,
        code: entry.code ?? null
      }))
    });
  });

  router.get('/:slug', (req, res) => {
    const entry = PROBLEMS[req.params.slug];
    if (!entry) {
      return respondProblem(
        req,
        res,
        'route-not-found',
        `No problem type "${req.params.slug}" is registered.`
      );
    }
    res.json({
      ok: true,
      type: problemType(req.params.slug),
      status: entry.status,
      title: entry.title,
      code: entry.code ?? null,
      description: entry.doc,
      specification: 'https://www.rfc-editor.org/rfc/rfc9457.html'
    });
  });

  return router;
}

export default {
  PROBLEMS,
  PROBLEM_BASE_PATH,
  PROBLEM_CONTENT_TYPE,
  ProblemError,
  buildProblem,
  problemFromError,
  problemRegistryRouter,
  problemType,
  respondProblem,
  sendProblem
};
