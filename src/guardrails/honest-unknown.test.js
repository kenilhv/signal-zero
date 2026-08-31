// Signal Zero - tests for GUARDRAIL 2 (honest unknowns)
// Run: node --test src/guardrails/
//
// The true negatives here include the product's OWN honest copy. If the
// guardrail fires on web/lib.js's "This is an absence of data, not a confirmed
// silence.", it fires on the correct answer, and an operator learns to ignore
// it. That string is a test case for exactly that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkHonestUnknown } from './honest-unknown.js';

const COLD = { coverageBasis: 'cohort-cold-start' };

function assertBlocked(text, ruleHint, options = {}) {
  const v = checkHonestUnknown(text, options);
  assert.equal(v.ok, false, `expected a violation for: ${text}`);
  assert.equal(v.blocked, true, `expected blocking for: ${text}`);
  if (ruleHint) {
    assert.ok(
      v.violations.some((x) => x.rule === ruleHint),
      `expected ${ruleHint} for "${text}", got ${v.violations.map((x) => x.rule).join(', ')}`
    );
  }
  return v;
}

function assertClean(text, options = {}) {
  const v = checkHonestUnknown(text, options);
  assert.equal(
    v.ok,
    true,
    `FALSE POSITIVE on honest text: "${text}" -> ${v.violations.map((x) => `${x.rule}:"${x.matched}"`).join(' | ')}`
  );
  return v;
}

// ---------------------------------------------------------------------------
// TRUE POSITIVES - absence converted into knowledge
// ---------------------------------------------------------------------------

const TRUE_POSITIVES = [
  ['Haku is confirmed silent since 26 August.', 'honest.confirmed-absence'],
  ['Ramche: verified silence for 40 hours.', 'honest.confirmed-absence'],
  ['The settlement is known quiet.', 'honest.confirmed-absence'],
  ['We have verified no survivors in the upper valley.', 'honest.catastrophe-from-absence'],
  ['Nobody survived in Haku Besi.', 'honest.catastrophe-from-absence'],
  ['The village was wiped out.', 'honest.catastrophe-from-absence'],
  ['Confirmed no casualties in Thulogaun.', 'honest.safety-from-absence'],
  ['We can confirm the settlement is safe.', 'honest.safety-from-absence'],
  ['Verified all clear for Dhunche.', 'honest.safety-from-absence'],
  ['Silence means the area is unaffected.', 'honest.absence-as-evidence'],
  ['No news is good news for these wards.', 'honest.absence-as-evidence'],
  ['No reports means nothing happened there.', 'honest.absence-as-evidence'],
  ['We know Syabru Besi is quiet.', 'honest.we-know-from-absence'],
  ['We have confirmed that Haku is empty.', 'honest.we-know-from-absence']
];

for (const [text, rule] of TRUE_POSITIVES) {
  test(`blocks absence-as-knowledge: ${text}`, () => {
    assertBlocked(text, rule);
  });
}

// ---------------------------------------------------------------------------
// TRUE NEGATIVES - honest text that must NOT trip a rule
// ---------------------------------------------------------------------------

const TRUE_NEGATIVES = [
  'No report has reached us from Haku since 26 August.',
  'This is an absence of data, not a confirmed silence.',
  'No report has ever resolved to this settlement. Its baseline comes from a cohort, not from its own history.',
  'We have not heard from Ramche; that is why it ranks first.',
  'Syabru Besi has not been reached by any confirming report.',
  'The settlement is unreachable by road, according to the DEOC bulletin.',
  'Security personnel reached Betrawati and confirmed 40 households were displaced.',
  '389 confirmed dead and more than 900 missing across three districts.',
  'The bridge was confirmed destroyed by the district engineer.',
  'This is not a confirmed silence and must never be presented as one.',
  'Coverage is partial: one connector stopped returning results.',
  'No casualties were reported by the district office in this ward.',
  'Its neighbours went quiet, it did not.',
  'Category: hazard-signal, confidence 0.61, resolved by alias match.',
  'We cannot confirm anything about Haku; no data has reached us.'
];

for (const text of TRUE_NEGATIVES) {
  test(`allows honest text: ${text.slice(0, 58)}`, () => {
    assertClean(text);
  });
}

// ---------------------------------------------------------------------------
// COLD-START FRAMING (context-gated rule)
// ---------------------------------------------------------------------------

test('cold-start: a bare silence claim demands the "reached us" framing', () => {
  const v = assertBlocked(
    'Haku has been silent for 41 hours.',
    'honest.missing-cold-start-framing',
    COLD
  );
  assert.equal(v.violations[0].severity, 'high');
});

test('cold-start: the honest framing satisfies the rule', () => {
  assertClean(
    'Haku has been silent in our feed for 41 hours - no report has reached us from there.',
    COLD
  );
});

test('the framing rule is inert without a cold-start coverageBasis', () => {
  assertClean('Haku has been silent for 41 hours.');
  assertClean('Haku has been silent for 41 hours.', { coverageBasis: 'own-history' });
});

// ---------------------------------------------------------------------------
// OBFUSCATION
// ---------------------------------------------------------------------------

test('catches leetspeak absence claims', () => {
  assertBlocked('c0nfirmed s1lent since Wednesday');
});

test('catches zero-width-separated absence claims', () => {
  assertBlocked('confir​med sil​ent since Wednesday');
});

// ---------------------------------------------------------------------------
// VERDICT SHAPE / GUARDS
// ---------------------------------------------------------------------------

test('negation suppression is recorded rather than silent', () => {
  const v = checkHonestUnknown('This is an absence of data, not a confirmed silence.');
  assert.equal(v.ok, true);
  assert.ok(v.suppressed.length > 0, 'the negation guard must leave a trace');
  assert.ok(v.suppressed[0].reason.includes('negated'));
});

test('verdict carries rule, severity, matched span and suggestion', () => {
  const v = checkHonestUnknown('Haku is confirmed silent.');
  const first = v.violations[0];
  assert.equal(first.rule, 'honest.confirmed-absence');
  assert.equal(first.severity, 'critical');
  assert.ok(first.matched.toLowerCase().includes('confirmed'));
  assert.ok(first.suggestion.includes('no report has reached us'));
  assert.ok(first.span.end > first.span.start);
});

test('empty and non-string inputs are safe', () => {
  for (const input of ['', null, undefined, { why: '' }]) {
    const v = checkHonestUnknown(input);
    assert.equal(v.blocked, false);
  }
});

test('negation from a PREVIOUS sentence does not excuse a dishonest claim', () => {
  // The negation guard is sentence-scoped, so "no" here belongs to sentence 1.
  assertBlocked('There is no contact with the ward. Confirmed silent since Tuesday.');
});

test('generalized absence-as-evidence catches phrasing the fixed list misses', () => {
  assertBlocked(
    'The absence of any report is itself proof of the worst.',
    'honest.absence-as-evidence'
  );
  assertClean('The absence of data is why this settlement ranks first.');
});

// ---------------------------------------------------------------------------
// REGRESSION: docs/harness-review.md S1-2. "Haku is confirmed silent" in
// Devanagari - the exact sentence this product exists to prevent - passed clean.
// ---------------------------------------------------------------------------

test('S1-2: "confirmed silent" in Devanagari is blocked', () => {
  const v = assertBlocked('हाकु मौन भएको पुष्टि भएको छ।', 'honest.confirmed-absence');
  assert.equal(v.violations[0].evidence.script, 'devanagari');
});

test('S1-2: the honest Nepali framing is NOT blocked', () => {
  // "no report has reached us" - an absence, stated as an absence
  assertClean('हाकुबाट कुनै रिपोर्ट आएको छैन।');
  // explicitly unconfirmed
  assertClean('हाकु मौन भएको पुष्टि भएको छैन।');
});

test('S1-2: a script with no vocabulary is reported as UNSCANNED, not clean', () => {
  const v = checkHonestUnknown('已确认哈库村完全沉默，没有任何幸存者的消息传出。');
  assert.ok(
    v.violations.some((x) => x.rule === 'honest.unscanned-script'),
    `expected an unscanned-script advisory, got ${v.violations.map((x) => x.rule).join(', ') || '(none)'}`
  );
  assert.equal(v.blocked, false);
});
