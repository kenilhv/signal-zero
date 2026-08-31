// Scoring for the golden set.
//
// The brief this suite is built to: a system that guesses confidently MUST score
// worse than a system that abstains. That is not a slogan, it is a property of
// the metric, so it is stated here as arithmetic and then TESTED in a-golden-set
// against two synthetic baselines.
//
// Two scorecards, deliberately separate:
//
//   RESOLUTION   - of the cases where a settlement genuinely can be identified,
//                  how many did we identify, and of the identifications we made,
//                  how many were right?
//   ABSTENTION   - of the cases where the honest answer is "we cannot say", how
//                  many did we correctly refuse, and of our refusals, how many
//                  were genuinely unresolvable?
//
// The asymmetry that makes guessing cost more than abstaining:
//
//   * a WRONG resolution (resolved, but to the wrong place, or resolved when the
//     answer was null) is a false positive in the resolution scorecard AND a
//     false negative in the abstention scorecard. It is counted twice.
//   * an ABSTENTION on a resolvable case is a false negative in the resolution
//     scorecard AND a false positive in the abstention scorecard - also twice,
//     but it is additionally tracked separately because in this domain the two
//     errors are not equally harmful: a missed resolution loses one confirming
//     report, a wrong resolution silently marks a settlement as covered when
//     nobody has looked at it. That is the failure the whole product exists to
//     prevent, so `harmWeightedError` weights it 3x. The weight is stated, not
//     hidden, and the guess-vs-abstain property is asserted with AND without it.

export const WRONG_RESOLUTION_HARM_WEIGHT = 3;
export const MISSED_RESOLUTION_HARM_WEIGHT = 1;

/**
 * @param {Array<{id, gold: string|null, predicted: string|null}>} rows
 */
export function scoreResolution(rows) {
  let tp = 0; // resolvable, resolved correctly
  let wrongPlace = 0; // resolvable, resolved to the WRONG settlement
  let overReach = 0; // not resolvable, resolved anyway
  let missed = 0; // resolvable, abstained
  let correctAbstain = 0; // not resolvable, abstained

  const errors = [];

  for (const r of rows) {
    const gold = r.gold ?? null;
    const pred = r.predicted ?? null;
    if (gold !== null && pred === gold) tp += 1;
    else if (gold !== null && pred !== null) {
      wrongPlace += 1;
      errors.push({ id: r.id, kind: 'wrong-place', gold, predicted: pred });
    } else if (gold === null && pred !== null) {
      overReach += 1;
      errors.push({ id: r.id, kind: 'over-reach', gold, predicted: pred });
    } else if (gold !== null && pred === null) {
      missed += 1;
      errors.push({ id: r.id, kind: 'missed', gold, predicted: pred });
    } else correctAbstain += 1;
  }

  const resolvedCount = tp + wrongPlace + overReach;
  const resolvableCount = tp + wrongPlace + missed;
  const unresolvableCount = overReach + correctAbstain;
  const abstainedCount = missed + correctAbstain;

  const resolution = {
    truePositives: tp,
    falsePositives: wrongPlace + overReach,
    falseNegatives: missed,
    precision: ratio(tp, resolvedCount),
    recall: ratio(tp, resolvableCount),
    f1: f1(ratio(tp, resolvedCount), ratio(tp, resolvableCount))
  };

  const abstention = {
    truePositives: correctAbstain,
    falsePositives: missed,
    falseNegatives: overReach,
    precision: ratio(correctAbstain, abstainedCount),
    recall: ratio(correctAbstain, unresolvableCount),
    f1: f1(ratio(correctAbstain, abstainedCount), ratio(correctAbstain, unresolvableCount))
  };

  const harmWeightedError =
    (wrongPlace + overReach) * WRONG_RESOLUTION_HARM_WEIGHT +
    missed * MISSED_RESOLUTION_HARM_WEIGHT;

  return {
    counts: { tp, wrongPlace, overReach, missed, correctAbstain, total: rows.length },
    resolution,
    abstention,
    // Unweighted composite: mean of the two F1s. Guessing and abstaining are
    // treated as equally costly here, so if guessing still loses on this it is
    // losing on the arithmetic, not on our thumb.
    macroF1: round((resolution.f1 + abstention.f1) / 2),
    harmWeightedError,
    // Lower is better; normalised so it is comparable across set sizes.
    harmWeightedErrorRate: round(harmWeightedError / Math.max(1, rows.length)),
    errors
  };
}

/** Category accuracy, honouring `categoryAny` for the genuinely-two-answer cases. */
export function scoreCategory(rows) {
  let correct = 0;
  const errors = [];
  for (const r of rows) {
    const accepted = r.acceptedCategories;
    if (accepted.includes(r.predicted)) correct += 1;
    else errors.push({ id: r.id, expected: accepted, predicted: r.predicted });
  }
  return { correct, total: rows.length, accuracy: ratio(correct, rows.length), errors };
}

/**
 * The single most important derived number in family A: how often the system
 * declared a settlement covered when the text did not support it. A false
 * corroboration resets a silence clock on a place nobody has looked at.
 */
export function scoreFalseCorroboration(rows) {
  const violations = rows.filter((r) => r.violated);
  return {
    checked: rows.length,
    violations: violations.length,
    rate: ratio(violations.length, rows.length),
    detail: violations
  };
}

function ratio(a, b) {
  return b === 0 ? 0 : round(a / b);
}

function f1(p, r) {
  return p + r === 0 ? 0 : round((2 * p * r) / (p + r));
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}
