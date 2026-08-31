// Signal Zero - tests for GUARDRAIL 1 (no dispatch)
// Run: node --test src/guardrails/
//
// The true-negative block is the important one. A guardrail that blocks
// legitimate output gets switched off within a day, and then it protects
// nothing. Every string in TRUE_NEGATIVES is text this system is SUPPOSED to
// be able to emit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkNoDispatch } from './no-dispatch.js';

const fired = (text) => checkNoDispatch(text);

function assertBlocked(text, ruleHint) {
  const v = fired(text);
  assert.equal(v.ok, false, `expected a violation for: ${text}`);
  assert.equal(v.blocked, true, `expected blocking for: ${text}`);
  if (ruleHint) {
    assert.ok(
      v.violations.some((x) => x.rule === ruleHint),
      `expected rule ${ruleHint} for "${text}", got ${v.violations.map((x) => x.rule).join(', ')}`
    );
  }
  return v;
}

function assertClean(text) {
  const v = fired(text);
  assert.equal(
    v.ok,
    true,
    `FALSE POSITIVE on legitimate text: "${text}" -> ${v.violations.map((x) => `${x.rule}:"${x.matched}"`).join(' | ')}`
  );
  return v;
}

// ---------------------------------------------------------------------------
// TRUE POSITIVES
// ---------------------------------------------------------------------------

const TRUE_POSITIVES = [
  ['Send teams to Syabru Besi immediately.', 'dispatch.directive-verb-resource'],
  ['We recommend deploying helicopters to Haku.', 'dispatch.directive-verb-resource'],
  ['You should dispatch a rescue team to Betrawati.', 'dispatch.directive-verb-resource'],
  ['Haku should go to the top of the response list.', 'dispatch.prescribed-movement'],
  ['Rescue crews must be sent there first.', 'dispatch.prescribed-movement'],
  ['This settlement is the priority for rescue.', 'dispatch.priority-as-assignment'],
  ['Direct resources to the upper Trishuli valley.', 'dispatch.channel-resources'],
  ['Deploy to Ramche now.', 'dispatch.imperative-sentence'],
  ['Head to Haku Besi before nightfall.', 'dispatch.stock-phrase'],
  ['Where to send the first responders: Ramche.', 'dispatch.stock-phrase'],
  ['{"dispatchTo": "np-rasuwa-haku"}', 'dispatch.field-shape'],
  ['assigned_to = "team-4"', 'dispatch.field-shape'],
  ['recommendedAction: move the convoy north', 'dispatch.field-shape'],
  ['Allocate ambulances to ward 3.', 'dispatch.directive-verb-resource'],
  ['Divert the convoy to Dhunche.', 'dispatch.directive-verb-resource'],
  ['Mobilise volunteers for Thulogaun.', 'dispatch.directive-verb-resource']
];

for (const [text, rule] of TRUE_POSITIVES) {
  test(`blocks dispatch language: ${text}`, () => {
    assertBlocked(text, rule);
  });
}

// ---------------------------------------------------------------------------
// TRUE NEGATIVES - legitimate text that must NOT trip a rule
// ---------------------------------------------------------------------------

const TRUE_NEGATIVES = [
  'The report was sent to us by the district emergency operations centre.',
  'Security personnel were deployed to Betrawati yesterday morning.',
  'A helicopter was dispatched by the army on Tuesday.',
  'Rescue teams reached the village and found forty households displaced.',
  'Relief supplies have been distributed in Dhunche since Wednesday.',
  'No confirming report has reached us from Haku since 26 August.',
  'This settlement ranks first by unexplained silence, not by report volume.',
  'The system never says where anyone should go.',
  'We do not recommend sending teams anywhere; approval only unlocks a list to read.',
  'Approval requires a named human and unlocks a sorted candidate list to read.',
  'Ranked in priority order by surprisal in nats.',
  'The army said it plans to send teams to Rasuwa later today.',
  'Two hundred residents were evacuated after the sirens sounded.',
  'Category: hazard-signal. Confidence 0.62. Settlement resolved from an alias match.',
  'The bridge at Betrawati is damaged and the road is blocked.',
  '{"category":"corroboration-candidate","settlementId":"np-nuwakot-betrawati","confidence":0.6,"why":"security personnel reached the settlement"}',
  'Water levels in the Trishuli river rose sharply after the outburst.',
  'A search team is already working in the area, according to the DEOC.'
];

for (const text of TRUE_NEGATIVES) {
  test(`allows legitimate text: ${text.slice(0, 58)}`, () => {
    assertClean(text);
  });
}

// ---------------------------------------------------------------------------
// OBFUSCATION
// ---------------------------------------------------------------------------

test('catches letter-spaced dispatch language', () => {
  const v = assertBlocked('s e n d  t e a m s  to Haku now');
  assert.ok(v.violations.some((x) => x.obfuscated), 'should be marked obfuscated');
});

test('catches leetspeak dispatch language', () => {
  assertBlocked('d1spatch t3ams to Ramche');
});

test('catches punctuation-split dispatch language', () => {
  assertBlocked('d-i-s-p-a-t-c-h teams to Ramche');
});

test('catches zero-width-separated dispatch language', () => {
  assertBlocked('sen​d tea​ms to Haku');
});

test('catches Cyrillic homoglyph substitution', () => {
  // "dispаtch" with a Cyrillic а
  assertBlocked('dispaаtch is wrong; dispаtch teams to Haku');
});

test('catches a dispatch field hidden under camelCase', () => {
  assertBlocked('{"deployTo":"np-rasuwa-ramche","confidence":0.9}', 'dispatch.field-shape');
});

// ---------------------------------------------------------------------------
// VERDICT SHAPE
// ---------------------------------------------------------------------------

test('verdict is structured, never a bare boolean', () => {
  const v = fired('Send teams to Haku.');
  assert.equal(typeof v, 'object');
  assert.equal(typeof v.ok, 'boolean');
  assert.equal(typeof v.blocked, 'boolean');
  assert.ok(Array.isArray(v.violations));
  const first = v.violations[0];
  assert.ok(first.rule.startsWith('dispatch.'));
  assert.ok(['critical', 'high', 'advisory'].includes(first.severity));
  assert.ok(first.matched.length > 0, 'matched span text is required');
  assert.ok(first.span && Number.isInteger(first.span.start) && Number.isInteger(first.span.end));
  assert.ok(first.suggestion.length > 0);
});

test('matched span indexes the ORIGINAL text, not a normalized copy', () => {
  const text = 'Context first. Send teams to Haku.';
  const v = fired(text);
  const hit = v.violations.find((x) => x.rule === 'dispatch.directive-verb-resource');
  assert.ok(hit, 'expected the directive rule to fire');
  const quoted = text.slice(hit.span.start, hit.span.end).toLowerCase();
  assert.ok(quoted.includes('send'), `span should quote the real text, got "${quoted}"`);
});

test('suppressions are recorded, not swallowed', () => {
  const v = fired('The army said it plans to send teams to Rasuwa later today.');
  assert.equal(v.ok, true, 'reported (not prescribed) dispatch must pass');
  assert.ok(v.suppressed.length > 0, 'the reporting guard must record why it let text through');
  assert.ok(
    v.suppressed.some((s) => s.reason.includes('reporting')),
    `expected a reporting suppression, got ${JSON.stringify(v.suppressed)}`
  );
});

test('empty and non-string inputs are safe', () => {
  for (const input of ['', null, undefined, 42]) {
    const v = checkNoDispatch(input);
    assert.equal(v.ok, true);
    assert.equal(v.blocked, false);
  }
});

test('a long clean article does not fire', () => {
  const article = TRUE_NEGATIVES.join(' ');
  assertClean(article);
});

// ---------------------------------------------------------------------------
// REGRESSION: the bypasses an adversarial review found open (docs/harness-review.md
// S1-2, S1-3, S2-2). Every string below PASSED CLEAN before the fix. They are
// here as named cases rather than as a paragraph in a doc, because a bypass that
// is only described in prose reopens the first time someone tunes a vocabulary.
// ---------------------------------------------------------------------------

test('S1-2: fullwidth Latin is not a hiding place (NFKD, not NFD)', () => {
  assertBlocked('Ｓｅｎｄ ｒｅｓｃｕｅ ｔｅａｍｓ ｔｏ Ｈａｋｕ.');
  assertBlocked('ｄｉｓｐａｔｃｈ ｈｅｌｉｃｏｐｔｅｒｓ ｔｏ Ｔｉｍｕｒｅ');
});

test('S1-2: a Devanagari dispatch directive fires', () => {
  const v = assertBlocked('हाकुमा तुरुन्तै उद्धार टोली पठाउनुहोस्।', 'dispatch.devanagari-directive');
  assert.equal(v.violations[0].evidence.script, 'devanagari');
});

test('S1-2: ordinary Nepali reporting does NOT fire - the triple is required', () => {
  // sent (perfective), no imperative marker
  assertClean('राहत सामग्री पठाइएको छ।');
  // resource without a sending stem
  assertClean('उद्धार टोली गाउँमा पुगेको छ।');
});

test('S1-2: a script with no vocabulary is reported as UNSCANNED, not clean', () => {
  const v = checkNoDispatch('救援队应立即前往哈库村，这是一个测试文本内容。');
  assert.ok(
    v.violations.some((x) => x.rule === 'dispatch.unscanned-script'),
    `expected an unscanned-script advisory, got ${v.violations.map((x) => x.rule).join(', ') || '(none)'}`
  );
  // Advisory: it records, it does not block.
  assert.equal(v.blocked, false);
});

test('S1-3: a negation in another clause does not excuse a directive', () => {
  assertBlocked('No confirmation has arrived, send rescue teams to Haku.');
  assertBlocked('Nothing is confirmed yet, send teams to Haku now.');
  assertBlocked('None of this is verified, dispatch helicopters to Timure.');
  assertBlocked('There is no doubt that responders should be sent to Haku first.');
});

test('S1-3: prescriptive framing now BEATS negation, as the header always claimed', () => {
  assertBlocked('No confirmation yet, you must send rescue teams to Haku.');
  assertBlocked('You must send rescue teams to Haku.');
});

test('S1-3: "without" negates a gerund, not a bare imperative', () => {
  assertBlocked('Without delay send helicopters to Syabru Besi.');
  // ...and still suppresses the construction it exists for
  assertClean('The ranking is published without sending teams to anyone.');
});

test('S2-2: a narration marker in the previous clause does not disable the rule', () => {
  assertBlocked('Today, send rescue teams to Haku.');
  assertBlocked('After review, send teams to Haku.');
});

test('S2-2: an auxiliary only narrates a verb form it could govern', () => {
  // "is send" is not a construction, so `is` earns no exemption
  assertBlocked('The situation is send teams to Haku.');
  // "is sending" is, so it does
  assertClean('The army is sending teams to Rasuwa, according to the bulletin.');
});

test('the negated-prescription exemption survives: the product says this about itself', () => {
  assertClean('We do not recommend sending teams anywhere; approval only unlocks a list to read.');
  assertClean('We never say send teams anywhere.');
  assertClean('Signal Zero does not dispatch teams to any settlement.');
});
