# Three kinds of silence — a product distinction the UI is currently flattening

Found by auditing live output on 2026-08-31. This is not a bug report; it is a modelling
observation that the data already supports and the interface does not yet express.

## The observation

Signal Zero currently presents one axis: `silenceHours`, high to low. But the live field carries
**three materially different states**, and they are not equally meaningful:

| | Count | What it means | How strong is the signal |
|---|---|---|---|
| **A — never heard from** | 23 / 32 | `coverageBasis: "cohort-cold-start"`, `reportCount: 0`. No report has *ever* resolved here. | Weak. We cannot separate "this place is quiet" from "nobody was ever looking". |
| **B — reported, then stopped** | 2 / 32 | `coverageBasis: "reports"`, `reportCount ≥ 1`, `silenceHours ≥ 24`. It was heard from, then went dark. | **Strongest signal in the system.** Coverage existed and then ceased. |
| **C — recently active** | 7 / 32 | Reported within 24h. | Not silent. |

Live category B, both real:

```
Kispang   96h since its last (and only) report   pop 9,840   coverageBasis: reports
Galchhi   24h since the last of 2 reports        pop 5,930   coverageBasis: reports
```

Kispang's `lastReportAt` is `2026-08-27T00:10:30Z` — roughly when the flood hit — and nothing
since. A settlement of 9,840 people was heard from once as the water arrived and has not been
heard from in four days.

## Why this matters more than the ranking does

The project's honest caveat has always been: *"silence currently means no data reached us, not
that a settlement went quiet."* That caveat applies in full to category A — all 23 of them.

It does **not** apply to category B. For Kispang and Galchhi we have an observed transition:
coverage existed, then stopped. That is the thing the product claims to detect, and it is
currently rendered identically to the 23 rows where we simply never looked.

Put plainly: the two rows that best prove the thesis are visually indistinguishable from the
twenty-three that merely admit ignorance.

## What follows for the interface

1. **Category B deserves its own visual treatment**, not a position in the same list. A settlement
   that went dark is a different object from one never observed. It is also the honest answer to
   the sharpest question a judge can ask: *"isn't this just measuring where journalists aren't?"* —
   for category B, no, it is not.
2. **Category A must keep its epistemic humility.** The `no data reached us` framing is correct and
   must not be quietly upgraded by proximity to category B.
3. **The count itself is a headline.** "2 settlements went dark after reporting" is a sentence an
   official immediately understands, and it is true.
4. `lastReportAt` is currently unused in the UI. For category B it is the most important timestamp
   in the record — the moment contact was lost.

## Caveat on the numbers

Category B is small (2 of 32) and will fluctuate between runs, because it depends on what the live
scrape resolved. It is not a stable demo prop. State the count from live data, never hard-code it,
and if a run yields zero, say zero — the mechanism is what matters, not the number on the day.
