---
name: no-dispatch-language
description: A hard writing guardrail for any text this system emits about settlements, silence or ranking. Bans every dispatch-shaped, recommendation-shaped and allocation-shaped construction (recommend, deploy, dispatch, assign, send, prioritize for rescue, responders should, direct resources to, focus efforts on) and gives the permitted observational rewrite for each, plus the honest-unknown phrasing rules for coverageBasis so that "no data reached us" is never written as "confirmed silent". Use this skill before writing ANY user-facing sentence, summary, alert text, incident note, tooltip, commit message or field description in Signal Zero - and always when describing a ranked settlement, an escalation, a cold start or what an operator should do next.
---

# No dispatch language

Everything this system writes describes **what is known and what is not known**. A human
decides where anyone goes. There is no exception, no field, no "just a suggestion", and no
tone of voice that makes an assignment acceptable.

## Why - and it is not squeamishness

Three concrete reasons, in order of how badly they bite.

1. **The system does not know the things a dispatch recommendation implies it knows.** The
   ranking measures *the absence of reports reaching us*. It has no view of road state, fuel,
   helicopter availability, who is already en route, what the district committee decided an
   hour ago, or whether a settlement was evacuated last week. A sentence that says "send a
   team to Haku" asserts a conclusion drawn from information the system has never seen.

2. **The measurement is about our inbox, not about the place.** "No report has resolved to
   Haku in 41 hours" is a fact about us. "Haku is cut off" is a claim about Haku, and we have
   no evidence for it - the same silence is produced by a destroyed village and by a
   correspondent with a flat battery. Dispatch language forces the second reading.

3. **Responsibility has to stay attached to a name.** The moment output reads as an
   assignment, accountability quietly migrates from the named approver to the model. The
   architecture is built so that a sorted list becomes readable only after a named human
   approves it; the prose must not smuggle back the authority the architecture removed.

The ranked list is **a reading order, not a route**.

## The three banned families

### A. Recommendation and obligation

`recommend`, `suggest`, `advise`, `should`, `must`, `need to`, `ought to`, `urge`, `it is
advisable`, `consider sending`, `warrants a visit`, `requires attention`, `calls for`.

Note that `should` is banned in the *actor* sense ("responders should"), not in the
conditional sense ("if the feed should stall"). When in doubt, rewrite.

### B. Movement and allocation

`deploy`, `dispatch`, `send`, `assign`, `allocate`, `direct`, `route`, `task`, `mobilize`,
`position`, `stage`, `commit`, `airlift`, `helicopter to`, `boots on the ground`,
`resource X`, `cover X with a team`, `first stop`, `start with`, `go to`, `head for`.

### C. Targeting and triage framing

`priority for rescue`, `top priority`, `highest-priority location`, `priority list`,
`target`, `target list`, `focus efforts on`, `concentrate on`, `triage these villages`,
`deprioritize`, `write off`, `rule out`, `next up`, `action this`, `hot spot to hit`.

### D. The subtle one - implicit dispatch through asserted need

This is the family that survives a naive find-and-replace, and it is the one to watch.
A sentence with no verb from lists A-C can still be an instruction, because asserting a
**need** implies the action that meets it:

- "Haku is cut off and needs rescue."
- "Timure has had no contact - people there are trapped."
- "Nobody has reached Syabrubesi; the situation is critical."
- "This is where the missing are."

Each asserts a fact about the settlement that the data does not contain, and each names an
action by implication. The test: *does this sentence tell a reader what the world is like
at that place, or only what has reached us?* If the former, it is out.

## BEFORE / AFTER

Every rewrite keeps the same information. Nothing is softened away; the claim is simply
returned to what was actually measured.

| BEFORE (banned) | AFTER (permitted) |
|---|---|
| "Recommend deploying a team to Haku." | "Haku has produced no resolved report for 41 h, against a cohort-expected gap of 9 h." |
| "Dispatch responders to Timure first." | "Timure holds rank 1 in the silence ordering. Its last resolved report was 2026-08-26T18:12+05:45." |
| "Responders should prioritize Syabrubesi." | "Syabrubesi sits above the 95th percentile of surprisal for its cohort (Gi* z = 3.1)." |
| "Send helicopters to the upper corridor." | "All four mainstem settlements above Betrawati are currently in cohort-cold-start." |
| "Assign the next team to Uttargaya." | "Uttargaya is the next entry in the ordering after Haku." |
| "Timure is the top priority for rescue." | "Timure is first in this ordering. The ordering ranks silence, not need." |
| "Focus search efforts on Rasuwa." | "Seven of the nine Rasuwa settlements have no resolved report in the window." |
| "Haku is cut off and needs immediate rescue." | "No report has resolved to Haku since the window opened. Whether that is damage or a communications outage is not determinable from this data." |
| "These villages have gone dark." | "No report in this window has resolved to these settlements." |
| "Nobody has reached Betrawati." | "No report *from* Betrawati has reached us. Whether anyone has reached Betrawati is unknown here." |
| "Confirmed silent for 41 hours." | "41 h since the last report that resolved to this settlement." |
| "Ranked by rescue priority." | "Ranked by silence anomaly: observed gap against the cohort's expected inter-report gap." |
| "Approve to task the field team." | "Approve to unlock the sorted list for reading. Approval records a name; it does not assign anyone." |
| "Critical - act now." | "Escalation candidate: surprisal and neighbourhood z-score both exceeded threshold at 14:20+05:45." |
| "Likely 2,110 people affected at Haku." | "Haku's recorded population is 2,110. No report has resolved to it; the number of people affected is unknown." |
| "The system suggests checking Ramche." | "Ramche appears at rank 6. The system reports the ordering; it does not select a destination." |
| "Rule out Gosaikunda - it is fine." | "Gosaikunda has three resolved reports in the window, the most recent 2 h ago." |

## Honest unknowns: `coverageBasis`

`coverageBasis` has exactly two values, and each has required and forbidden phrasing.

### `"reports"`

At least one report in the window resolved to this settlement. Its silence interval and its
inter-report statistics are **its own**.

- Say: "last resolved report 4 h ago", "3 corroborating clusters", "measured from this
  settlement's own report history".
- Still do not say: "confirmed safe", "accounted for", "clear". One report is one report.

### `"cohort-cold-start"`

**Zero reports have ever resolved to this settlement.** Two consequences that must both be
stated, because stating only the first is the dishonest half:

1. `silenceHours` is measured **from the moment the observation window opened**, not from a
   last contact - there is no last contact.
2. `expectedGapHours` and the underlying rate are **borrowed from the cohort**. Nothing in
   that number came from this settlement.

Required phrasing, in one form or another:

> "No report has ever resolved to Haku in this window. Its expected reporting rate is
> borrowed from cohort `rasuwa-tier3`; the silence interval is measured from the window
> opening, not from a last contact."

Forbidden phrasing, all of it, without exception:

| Never write | Because |
|---|---|
| "confirmed silent" | Nothing was confirmed. We observed our own inbox. |
| "verified no contact" | Same. There was no verification step. |
| "has gone dark" / "gone quiet" | Implies a transition we did not observe. It may never have reported. |
| "communications are down at X" | An assertion about X's infrastructure. We have no such data. |
| "X is cut off" / "unreachable" / "isolated" | Assertions about access, which we do not measure. |
| "no survivors have been heard from" | Converts absence of documents into a claim about people. |
| "silence confirmed by absence of reports" | Circular, and dresses absence as evidence. |
| "0 reports means total devastation" | The most expensive sentence this system could emit. |

The one-line discipline: **"no data reached us" is a statement about us. Any sentence whose
subject is the settlement needs evidence about the settlement.**

### `fitBasis`, and the same discipline elsewhere

- `fitBasis: "cohort"` → "rate fitted from N gaps in cohort `<key>`".
- `fitBasis: "global"` → "the cohort had too few gaps to fit; the rate is the global fallback",
  which is a *weaker* claim and must be said out loud, not silently rendered as a number.
- `anomalyType` describes the shape of a statistic (`solo` versus regional), never a severity
  of harm. "Solo anomaly" means this settlement is quiet while its neighbours are not; it does
  not mean it is worse off.
- `isEscalationCandidate: true` means **"eligible to be shown to a named human"**. It does not
  mean "requires action", "confirmed emergency", or "escalated". Write "eligible for review",
  never "escalated for rescue".
- `corroborationCount` counts **clusters of reports**, not confirmations of safety. Never
  render 0 as "unconfirmed casualties" or 5 as "confirmed safe".
- Population is context. Never multiply population by anything to produce an estimate of
  people affected, and never place a population figure next to a silence figure in a way that
  reads as a casualty estimate.

## Self-check before emitting

Run this against every sentence. It is cheap and it catches the ordinary failures.

1. **Verb check** - grep the draft, case-insensitive:

   ```
   recommend|suggest|advis|should|must |need to|urge|deploy|dispatch|
   send |assign|allocat|mobiliz|route |task |airlift|prioriti[sz]|priority|
   target|focus (on|efforts)|first stop|start with|go to|head for|
   triage|deprioriti|write off|act now|urgent
   ```

2. **Subject check** - for every sentence whose grammatical subject is a settlement, ask:
   what evidence do we hold *about that settlement*? If the answer is "the absence of
   documents", rewrite so the subject is the report, the ordering, or the interval.

3. **Imperative check** - does any sentence have an implied "you"? Delete it.

4. **Certainty check** - do the words "confirmed", "verified", "known", "certainly",
   "clearly" appear anywhere near a cold-start settlement? Remove them.

5. **The substitution test** - replace the settlement name with "a place we have no reports
   from" and re-read. "Send a team to *a place we have no reports from* first" exposes the
   claim immediately. If the sentence becomes absurd or unsupportable, it was dispatch.

## Permitted vocabulary

Build sentences from these and the guardrail holds by construction:

- "No report has resolved to X in the current window."
- "The last report that resolved to X was at `<timestamp>`."
- "X has been silent for 41 h against a cohort-expected inter-report gap of 9 h."
- "Surprisal 4.6; neighbourhood Gi* z-score 3.1."
- "Corroboration count 0, from 0 clusters."
- "Coverage basis: cohort-cold-start - every rate figure here is borrowed."
- "X is at rank 3 in the silence ordering."
- "Eligible for review by a named approver."
- "This ordering is a reading order. It is not an assignment, and it does not describe
  conditions on the ground."
- "Unknown." "Not determinable from this data." "No evidence either way."

That last group is not a failure to answer. It is the answer, and it is the one thing this
system can say that most others cannot.
