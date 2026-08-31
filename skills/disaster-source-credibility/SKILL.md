---
name: disaster-source-credibility
description: Judge the evidentiary weight of a disaster report before it is allowed to count as corroboration - source tier, eyewitness versus aggregated reporting, wire-copy propagation (twelve outlets carrying one AP story is ONE observation, not twelve), publication-time versus observation-time ambiguity in relative timestamps, and detection of recycled photos and reports about a different flood. Use this skill whenever you assess whether a news article, bulletin or social post confirms anything, whenever you count corroborations or deduplicate reports, whenever you see phrases like "according to officials", "2 days ago", "file photo" or an unattributed death toll, and whenever a report is about a Nepali flood - even if the request only says "summarize these sources".
---

# Evidentiary weight of a disaster report

You are deciding one thing: **does this document count as an observation that reached us
from a specific place, and if so, how many observations is it?**

That question is not "is this outlet reputable". A perfectly reputable national newspaper
rewriting an agency dispatch adds zero observations. A shaky phone video from a named
person standing in a bazaar adds one.

## Why over-counting is the dangerous direction

This assessment feeds a system that ranks settlements by how long they have gone silent.
Corroboration is what marks a settlement as heard-from and pushes it down the ranking.

- **Under-count corroboration** → a settlement stays visible slightly longer than it needed
  to. Cheap, recoverable.
- **Over-count corroboration** → a settlement is marked covered on the strength of documents
  that contain no observation of it. **It disappears from the ranking, and the silence is
  never surfaced.**

Every rule below resolves ties toward under-counting. When you cannot tell whether two
documents are independent, they are **one**. When you cannot tell whether a claim is
eyewitness or aggregated, it is **aggregated**. When a timestamp is a range, take the
**oldest** end.

## Output

```json
{
  "sourceTier": 1,
  "claimType": "eyewitness",
  "independentObservations": 1,
  "observationTimeEarliest": "2026-08-26T14:00:00+05:45",
  "observationTimeLatest": "2026-08-27T09:30:00+05:45",
  "corroborates": "np-rasuwa-timure",
  "flags": ["relative-timestamp"],
  "weight": 0.8,
  "why": "Nepal Police district office bulletin, first-hand count at a named location"
}
```

`corroborates` is a settlement id or `null`. `null` is a normal, frequent, correct answer.
`weight` is in [0,1] and is the product of the tier, the claim type and the flags - not a
vibe. Never emit a `weight` above 0.5 with `claimType: "aggregated"`.

## 1. Source tiers

| Tier | Kind | Examples in this theatre |
|---|---|---|
| **1** | Official government / authority bulletin | NDRRMA, Ministry of Home Affairs, Nepal Police, Nepal Army, Armed Police Force, Department of Hydrology and Meteorology (DHM), District Disaster Management Committee, the district administration office, ICIMOD for glacial-lake technical assessment |
| **2** | National wire or national outlet | RSS (Rastriya Samachar Samiti, the state news agency), Kantipur, The Kathmandu Post, Onlinekhabar, Setopati, Nagarik, Republica, The Himalayan Times |
| **3** | International outlet | AP, Reuters, AFP, BBC, Al Jazeera, Xinhua, The Guardian |
| **4** | Local outlet / district correspondent | district FM stations, Rasuwa- and Nuwakot-based portals, stringers filing from the corridor |
| **5** | Social post | X, Facebook, TikTok, YouTube, Reddit, forwarded WhatsApp messages |

Signal Zero's own ingest carries a coarser `sourceType` of `official`, `news` or `social`.
Tier 1 maps to `official`; tiers 2-4 to `news`; tier 5 to `social`.

### The inversion that matters

**Tier is institutional weight. It is not proximity, and proximity is what this system needs.**

A tier-3 international wire is almost always a *re-report* of a tier-1 or tier-2 source; it
adds credibility to a claim that already existed and adds **no new observation**. A tier-5
social post from someone standing on the Betrawati bridge is a first-hand observation, and
it is the only kind of document that can tell you a specific settlement was reached.

So carry two axes, always:

```
                 close to the event  <---------------->  far from the event
  high standing  tier-1 field bulletin                   tier-1 national summary
   low standing  tier-5 post from the bazar              tier-5 repost of a headline
```

The top-left is the most valuable document in the corpus. The top-right corroborates
nothing at settlement level. Do not collapse this into one number, and do not let tier
alone decide `corroborates`.

## 2. Eyewitness versus aggregated

This is the single most load-bearing distinction in the skill, because **only an eyewitness
or a first-hand institutional observation can corroborate a settlement.**

### Eyewitness markers

- First person, present or immediate past: "I am at", "we saw", "our house", "just now".
- Sensory and physical detail that a rewriter would not add: the colour of the water, a
  named shopfront, the number of vehicles at a specific crossing.
- Micro-location below settlement level: "ward 4", "the suspension bridge", "behind the
  health post", "the bus park".
- A named individual with a stated role and location, quoted about what **they** saw:
  "Ward chair Kamal Tamang, reached by phone in Uttargaya, said water was in the market".
- Device-local time or an event-relative time: "since about 2 pm", "an hour after the siren".
- An institutional first-hand count: a police post reporting its own tally, a hospital
  reporting its own admissions, a rescue team reporting what it reached.

### Aggregated markers

- Attribution without location: "according to officials", "authorities said", "reports say",
  "as per the district administration".
- Roll-up arithmetic: "the death toll has risen to", "at least N dead across three
  districts", "N missing nationwide".
- Administrative geography as the subject: the sentence is about **Rasuwa district**, not
  about a place in it.
- Passive voice with no observer: "villages were reported cut off", "damage was extensive".
- Hedged plurals: "several settlements", "many villages", "areas along the river".
- A summary paragraph in a live blog or an explainer.

### The rule

> **An aggregated district-level or national-level claim cannot corroborate any settlement
> inside it, no matter which tier it came from.**

A government bulletin saying "Rasuwa: 71 confirmed dead, 210 missing" is a tier-1 document
with `corroborates: null`. It is excellent evidence about the *scale* of the event and no
evidence at all that anyone has heard from Timure. The two are different claims and the
system needs the second one.

Conversely a tier-5 post reading "we walked out from Haku this morning, about forty of us,
the trail above the village is gone" **does** corroborate Haku - a person was there and
communicated. Lower `weight`, not `null`.

**A death toll is never a corroboration.** Casualty figures are aggregations by
construction; they arrive from a counting process, not from a place.

## 3. Wire propagation - counting observers, not documents

Twelve outlets carrying one AP dispatch is **one** observation. This is not a nicety; the
corroboration count is what suppresses a settlement in the ranking, so an uncorrected wire
cascade can bury a real silence twelve times over.

### How to detect a re-report

Strongest signals, roughly in order:

1. **Byline or credit line**: "AP", "Reuters", "AFP", "Agencies", "RSS", "with inputs from
   agencies", "PTI/ANI". Any of these means the observation belongs to the named agency,
   not to the outlet.
2. **Identical numerals to the same digit** across outlets in a short window: "389 dead,
   1,500 missing" repeated exactly is one counting process, not several.
3. **An identical or near-identical quote**, same speaker, same wording, same clause order.
   Two reporters do not transcribe the same sentence identically.
4. **Shared lede structure** with only the first clause reordered - the classic rewrite.
5. **Aggregator republication**: Yahoo News, MSN, Google News, news apps, subreddit and
   Telegram mirrors. Never independent, ever.
6. **Translation laundering**: a Nepali-language original republished in English looks like
   entirely different text under any string comparison, and is the same observation. Check
   for a matching quote, a matching figure, and a matching named official.
7. **Timestamp cascade**: a cluster of publications within minutes to a few hours after one
   earlier publication, all with the same facts and none with a new one.

### Counting rule

> Independence requires either a **distinct human observer** or a **distinct institutional
> collection process**. Count those, not documents.

- Twelve outlets, one AP dispatch → **1**.
- AP dispatch **and** an NDRRMA bulletin, with different figures and different named
  officials → **2**.
- AP dispatch and an outlet that adds its own correspondent's paragraph from Betrawati →
  **2**, but the second observation corroborates only Betrawati, only via that paragraph.
- Three social posts that are all reposts of one video → **1**, attributed to the original
  poster's location.
- Two social posts from two different named people in the same bazar → **2**.

When you cannot establish independence, return **1** and flag `possible-syndication`.

### Source-type diversity as a check

Three documents that are all `news` are a weaker cluster than three documents that are
`official`, `news` and `social`, even at the same count, because the three types are
collected by genuinely different processes. Note diversity in `why`; it is a reason to
trust a count of 3, not a reason to inflate a count of 1.

## 4. Time: three clocks, and they disagree

Every report has three timestamps and confusing them corrupts a silence measurement
directly, because the silence clock is measured from **observation** time.

| Clock | What it is | Where it comes from |
|---|---|---|
| `t_observe` | when the thing was actually seen | the text, usually implicit |
| `t_publish` | when the document was published | the byline or metadata |
| `t_collect` | when we scraped it | our own ingest |

`t_collect` is never evidence about the event. Using it as the report time resets a
settlement's silence clock to *now* on the strength of a three-day-old article. This is the
most common way a silence gets erased by accident.

### Relative timestamps

"2 days ago", "yesterday", "Tuesday", "earlier this week", "last night" are **ranges**, not
instants. Resolve them against `t_collect` and keep both ends:

| Text | Interval, relative to collection at T |
|---|---|
| "2 days ago" | `[T-3d, T-2d]` - "2 days ago" is truncated, so it may be 2.9 days |
| "yesterday" | `[T-2d, T-1d]` |
| "last night" | `[T-1d, T-12h]` roughly, and only if T is in the morning |
| "earlier this week" | `[start of week, T]` |
| a bare weekday name | the most recent occurrence, `[that day 00:00, that day 23:59]` |

> **Use the earliest end of the interval as the observation time.** Over-stating recency
> understates silence, which hides a settlement. Under-stating recency only makes the system
> slightly more cautious than it needed to be.

### Live blogs and "updated" stamps

A liveblog page carries a page-level "Updated 5 minutes ago" while individual entries are
hours or days old. **Timestamp the paragraph, not the page.** If the Timure paragraph in a
liveblog is three days old, that observation is three days old regardless of how fresh the
page metadata looks. Flag `page-level-timestamp` whenever the only available time is the
page's.

### Nepal-specific time traps

- **Nepal Standard Time is UTC+05:45.** The 45-minute offset is not a typo, and naive
  parsers silently treat local timestamps as UTC, shifting every report by nearly six hours.
  A date-only Nepali source parsed as UTC midnight can land on the wrong calendar day.
- **Bikram Sambat dates.** Nepali-language sources date in BS, roughly 56-57 years ahead:
  26 August 2026 falls in **Bhadra 2083 BS**. A year field reading "2082" or "2083" is a BS
  year, not a corrupt Gregorian one, and BS month names (Baisakh, Jestha, Ashadh, Shrawan,
  Bhadra, Ashwin, Kartik...) will not parse at all. Flag `bs-date` and convert, or treat the
  time as unknown - never discard the document for having an unparseable date.
- Republished archive material often keeps its original date while acquiring a new URL.

## 5. Recycled imagery and reports about a different flood

Nepal has frequent, visually similar flood disasters. Misattributing one to this event
imports its whole coverage footprint into this corridor and silences real settlements.

### Prior events that are commonly confused with this one

| Event | Where | Why it gets confused |
|---|---|---|
| **July 2024/2025 Rasuwagadhi Bhote Koshi flood** | *This exact corridor*, Timure / Rasuwagadhi | Same river, same place names, destroyed the Miteri bridge and the dry port. Anything dated 2024 or 2025 about Rasuwagadhi is a **prior event**, not this one. |
| **2021 and 2016 Melamchi floods** | Sindhupalchok | Same Himalayan flash-flood imagery, different drainage |
| **2015 Gorkha earthquake** | Langtang, Haku | The most-circulated Rasuwa disaster imagery in existence; Haku was destroyed then too |
| **Sindhupalchok Bhote Koshi / Araniko events** | Sindhupalchok | Same river *name*, entirely different river - see the `nepal-settlement-resolution` skill |
| **Sept 2024 Kathmandu valley floods** | Bagmati valley | Same province, same monsoon vocabulary |

Any document naming Barhabise, Tatopani, Kodari, Melamchi, Jure or Listi is about a
different river system. Any document whose own date is a prior year is about a prior event,
even if every place name matches.

### Recycled-photo checks

- **Caption/date mismatch**: the image carries an older agency date, "file photo", "archive",
  "for representation only", or a watermark from an unrelated agency.
- **The same image with two different captions** across events. If an image is doing work in
  the claim, its first known appearance is the one that dates it.
- **Season and terrain mismatch**: snow line, foliage colour, river level and crop stage
  should match late August in the Nepali monsoon. Dry riverbeds, bare trees or deep snow at
  valley bottom are wrong for this event.
- **Foreign context**: signage in the wrong script, vehicle plates, road markings, building
  styles from Pakistan, Uttarakhand or China rather than Nepal.
- **Implausible provenance**: a "just filmed" clip with no motion blur, no ambient sound, a
  broadcast lower-third, or a resolution and aspect ratio typical of archive footage.

### The rule for images

> **An image never corroborates a settlement on its own.** Corroboration requires a
> *textual* claim that places an observation at a named settlement. An image can strengthen
> an already-textual claim and can never create one.

A photo captioned "Timure" with no accompanying first-hand text is `corroborates: null`,
`flags: ["image-only"]`. This is deliberately strict: a caption is the cheapest thing in the
corpus to get wrong or to fabricate, and the cost of believing it is a hidden silence.

## 6. Procedure

1. Assign the **tier** from the outlet, and separately record whether the document is close
   to or far from the event.
2. Find the **specific sentence** that would corroborate a settlement. If you cannot quote
   one, `corroborates` is `null` and you are done.
3. Classify that sentence as **eyewitness** or **aggregated**. Aggregated → `corroborates`
   is `null`.
4. Check for **syndication** against the rest of the corpus. Set
   `independentObservations`; when unsure, 1.
5. Resolve the **three clocks**; emit the interval and take the earliest end.
6. Run the **wrong-event and recycled-image** checks. Any hit → `corroborates: null` plus
   the flag.
7. Only then compute `weight`, and state in `why` which sentence carried the observation.

## Worked examples

| Document | Verdict |
|---|---|
| Reuters: "At least 389 people have died, officials said, with 1,500 missing across Rasuwa, Nuwakot and Dhading." | tier 3, aggregated, `corroborates: null`. A death toll from unnamed officials over three districts. |
| Eleven outlets, same day, all carrying that Reuters paragraph verbatim | `independentObservations: 1`, flag `syndicated`. Not eleven. |
| NDRRMA situation report: "Rasuwa: 71 dead, 210 missing." | tier 1, aggregated, `corroborates: null`. High weight as scale evidence, zero as settlement evidence. |
| Nepal Police post at Betrawati: "Our post has registered 34 displaced families since 3 pm." | tier 1, eyewitness institutional, `corroborates: np-nuwakot-betrawati`, weight 0.9. |
| Facebook post, named user: "We are safe in Syabrubesi, the lower bazar is gone, phones work at the school." | tier 5, eyewitness, `corroborates: np-rasuwa-syabrubesi`, weight 0.6. Lower tier, real observation. |
| Same video reposted by four accounts | `independentObservations: 1`, credited to the original poster. |
| Photo captioned "Timure today", no text | `corroborates: null`, flag `image-only`. |
| Kathmandu Post article, page shows "Updated 12 minutes ago", the Haku paragraph says "on Tuesday" | observation interval is Tuesday, not now. Flags `page-level-timestamp`, `relative-timestamp`. |
| 2025 article about the Bhote Koshi destroying the Rasuwagadhi dry port | flag `wrong-event`, `corroborates: null`. Prior year, prior flood. |
| Onlinekhabar in Nepali and an English site with the same quote from the same CDO | `independentObservations: 1`, flag `translation-duplicate`. |
