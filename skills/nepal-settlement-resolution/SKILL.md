---
name: nepal-settlement-resolution
description: Resolve a place mention in messy disaster text to one of the 32 gazetteer settlements in Nepal's Trishuli river corridor (Rasuwa, Nuwakot, Dhading), or return UNRESOLVED. Covers Nepali transliteration variants, the district / municipality / ward hierarchy, river-corridor geography and upstream-downstream ordering, and the confusable place pairs that produce wrong matches. Use this skill whenever text mentions a Nepali place name, a Nepali district, the Trishuli or Bhote Koshi rivers, Rasuwagadhi, Syabrubesi, Timure, Dhunche or Betrawati, or whenever you are asked to geolocate, geocode, resolve, match or disambiguate a settlement for the 2026 Trishuli GLOF - even when the request does not use the word "gazetteer".
---

# Resolving a place mention in the Trishuli corridor

You are matching free text - wire copy, an official bulletin, a social post - to exactly one
entry in a fixed 32-settlement gazetteer covering Rasuwa, Nuwakot and Dhading districts of
Bagmati Province, Nepal.

**The full settlement table, alias list and downstream ordering are in
`references/corridor.md`. Read it before resolving anything.** Never resolve to a name that
is not in that table.

## The asymmetry that decides every hard call

This gazetteer feeds a system that ranks settlements by how long they have gone **silent**.
A resolved mention is treated as a report *reaching us from* that settlement, which resets
its silence clock and pushes it **down** the ranking.

So the two errors are not symmetric:

| Error | Consequence |
|---|---|
| **False negative** - you return UNRESOLVED for a mention that really was about Timure | Timure keeps its silence. It stays visible. Recoverable. |
| **False positive** - you resolve "Rasuwa district" to Timure | Timure is now marked as heard-from. **It drops off the list. The silence is hidden.** |

A wrong resolution does not merely add noise; it *deletes* the exact signal the system exists
to surface. **When in doubt, return UNRESOLVED.** UNRESOLVED is an honest answer and costs
nothing. A guess is a silent deletion.

## Output

Return JSON only:

```json
{"settlementId": "np-rasuwa-timure", "confidence": 0.86, "why": "names Timure Bazar directly"}
```

- `settlementId` must be an id copied verbatim from the gazetteer (or from the shortlist you
  were offered, if one was offered). Anything else is invalid.
- **UNRESOLVED is expressed as `"settlementId": null`.** In prose, write the literal word
  `UNRESOLVED`. Never write "probably Timure", "likely Rasuwa somewhere", or a district name
  in the settlement field.
- `confidence` is bounded by how you matched, not by how confident the prose sounds:
  exact name or listed alias 0.85-0.95; unambiguous transliteration variant 0.7-0.85;
  reasoned from corridor context 0.5-0.7. Below 0.5, return `null` instead.

## Step 1 - Normalize before comparing

Apply, in order: NFD-decompose and strip diacritics, lowercase, collapse every non-alphanumeric
run to a single space, trim. `Syābru-Besi` and `SYABRU BESI` both become `syabru besi`.

Then strip these **administrative and generic suffixes** before matching, but remember which one
you stripped - it is evidence, not noise:

| Suffix | Means | Note |
|---|---|---|
| `Gaunpalika` / `Gaonpalika` / `Rural Municipality` | rural municipality | administrative unit, not the village |
| `Nagarpalika` / `Municipality` | urban municipality | ditto |
| `Bazar` / `Bazaar` / `Bajar` | market town | often part of the real name (Trishuli Bazar) - strip for comparison, keep in output |
| `Besi` / `Bensi` | valley floor / lowland | Syabrubesi, Haku Besi, Dhading Besi, Dhunibesi |
| `Gaun` / `Gaon` | village | Thulogaun, Haku Gaun |
| `Khola` | stream / small river | **a stream is not a settlement** - see step 5 |
| `Ghat` | riverbank landing | Devighat, Benighat |
| `Chowk` | crossroads | Battar Chowk |
| `Ward N` / `Ward no. N` | ward inside a municipality | see step 3 |

## Step 2 - Nepali transliteration variance

Devanagari has no single Roman spelling. All of the following are the *same* name, and the
pairs below are real and appear in this corridor's coverage:

| Rule | Devanagari cause | Real examples |
|---|---|---|
| **b ↔ v** | व has no fixed Roman value | Betrawati / Betrabati, Bidur / Vidur, Netrawati / Netravati |
| **w ↔ v ↔ b** | same | Betrawati / Betrawoti / Betrabati |
| **aspiration dropped** | ध/द, छ/च, घ/ग | Dhunche / **Dunche**, Galchhi / Galchi, Belkotgadhi / Belkotgadi, Khaniyabas / Khaniyabash |
| **sh ↔ s** | श/ष/स | Syabrubesi / **Shyaphrubesi**, Shivapuri / Sivapuri, Tarkeshwar / Tarkeswar |
| **p ↔ ph** | प/फ | Syabrubesi / **Syaphrubesi** |
| **nasal dropped or kept** | anusvara | Syabrubesi / **Syabrubensi**, Dhunibesi / Dhunibensi |
| **word break is arbitrary** | compounds | Syabrubesi / **Syabru Besi**, Thulogaun / **Thulo Gaun**, Uttargaya / **Uttar Gaya**, Kalikasthan / Kalika Sthan |
| **final vowel drift** | schwa, au/o | Thulogaun / Thulogaon, Dhunche / Dhunchhe, Ramche / Ramchhe |
| **-i ↔ -ee, -o ↔ -au** | long vowels | Gajuri / Gajoori, Betrawati / Betrawoti |
| **e ↔ a in अ/ए** | | Tarkeshwar / Tarkeshwor, Dupcheshwar / Dupcheshwor |

**A whitespace difference or a single one of these substitutions is not evidence of a
different place.** Two or more unrelated substitutions plus a different district is.

Do not invent variants outside these rules. `Timure` → `Tamur` is not a transliteration
variant; the Tamur is a river in eastern Nepal, 400 km away.

## Step 3 - District ≠ municipality ≠ ward ≠ settlement

Nepal's structure since 2017:

```
Bagmati Province
└── District            Rasuwa | Nuwakot | Dhading      <- what national outlets name
    └── Local level     gaunpalika (rural) / nagarpalika (urban)
        └── Ward        numbered 1..n
            └── Settlement / bazar / tole                <- what the gazetteer holds
```

The same string can denote two or three of these levels at once. In this corridor:

- **Uttargaya** is a rural municipality *and* a settlement. Both are in scope; resolve to the
  settlement id, but only if the text is about a place, not about a council decision.
- **Bidur** is a municipality, the settlement, and the district headquarters of Nuwakot.
  "Nuwakot Bazar" is an alias of Bidur.
- **Nilkantha** is a municipality whose seat is **Dhading Besi / Dhadingbesi**, the district
  headquarters of Dhading. Text naming "Dhadingbesi" resolves to `np-dhading-nilkantha`.
- **Naukunda** and **Parbatikunda** are rural municipality names; they appear as aliases of
  Ramche and Thulogaun respectively.
- **Benighat Rorang** is the rural municipality; **Benighat** is the settlement at the
  Budhi Gandaki confluence.

### The district-only rule (the most important rule in this skill)

**A mention that names only a district resolves to nothing.**

> "Massive flooding reported across Rasuwa district; the death toll continues to climb."

Rasuwa district contains **nine** gazetteer settlements: Timure, Syabrubesi, Haku, Dhunche,
Gosaikunda, Uttargaya, Ramche, Kalikasthan, Thulogaun. There is no basis in that sentence to
prefer any one of them. Return `null`.

The temptation is to pick the most famous or most exposed one - Timure, because it is the
border town and the headline location. **That is precisely the failure.** It marks the most
exposed settlement as heard-from on the strength of a sentence that never mentioned it, and
removes it from the silence ranking. Resist it every time.

The same applies to:
- "Nuwakot" alone (fifteen settlements), "Dhading" alone (eight).
- "Bagmati Province", "northern Nepal", "the Nepal-China border area", "Langtang region".
- "three districts", "the affected districts", "upstream areas".
- A national roll-up figure attached to a district: "Rasuwa: 71 dead" is a district statistic,
  not a settlement observation.

**A district name is only usable as a *tie-breaker*,** never as a match on its own. If the text
names "Ramche" and also says "Rasuwa", the district confirms `np-rasuwa-ramche`. If the text
names "Ramche" and says "Sindhupalchok", you have a conflict - return `null` and say so.

### Ward mentions

"Uttargaya-4" or "ward 4 of Uttargaya rural municipality" resolves to Uttargaya at reduced
confidence (~0.6): the ward is *inside* the unit, so the settlement is at least implicated.
But "ward 4" with no unit name resolves to nothing.

## Step 4 - The corridor is a line, and water runs down it

The hazard is a glacial lake outburst flood originating in Tibet, entering Nepal on the
**Bhote Koshi**, which becomes the **Trishuli**. Settlements are ordered along that line.
Upstream to downstream on the mainstem:

```
Tibet / Kyirong (Gyirong)
  │  border at RASUWAGADHI  ── this is a fort/customs point, NOT a settlement entry.
  │                             It is an ALIAS OF TIMURE.
  ▼
Timure            Rasuwa    28.216 N   tier 3   pop 1,240
Syabrubesi        Rasuwa    28.163 N   tier 3   pop 3,180   (Langtang Khola joins here)
Haku              Rasuwa    28.062 N   tier 3   pop 2,110
Uttargaya         Rasuwa    28.028 N   tier 3   pop 2,860
Betrawati         Nuwakot   27.966 N   tier 3   pop 4,820   <- RASUWA/NUWAKOT BOUNDARY
Trishuli Bazar    Nuwakot   27.920 N   tier 3   pop 12,600
Battar            Nuwakot   27.905 N   tier 3
Devighat          Nuwakot   27.902 N   tier 3
Bidur             Nuwakot   27.870 N   tier 3   pop 28,400  (Nuwakot district HQ)
Galchhi           Dhading   27.796 N   tier 3
Gajuri            Dhading   27.766 N   tier 3
Benighat          Dhading   27.800 N   tier 3   (Budhi Gandaki joins; Mugling is beyond)
```

Everything else in the gazetteer sits **off the mainstem** - on ridges, side valleys and
tributaries - which is why it carries hazard tier 1 or 2. **Dhunche is the clearest case:
it is the district headquarters of Rasuwa and the biggest name in the district, but it sits
up on the road above the river, not on the flood plain.** Road adjacency is not river
adjacency. Do not let Dhunche's prominence pull mainstem mentions toward it.

Use the corridor for three things, and nothing else:

1. **Ordering sanity.** A GLOF wave arrives upstream first. An observation at Timure and one
   at Betrawati three hours later is consistent. The reverse ordering, in the same hour, is a
   reason to doubt one of the timestamps - not a reason to re-resolve the place.
2. **Direction words.** "Upstream of Betrawati" excludes everything below it. "Downstream of
   Syabrubesi" excludes Timure. This *narrows* a candidate set; it does not pick a winner.
   Narrowing nine candidates to four still returns `null`.
3. **Neighbour plausibility.** A mention that lands between two named settlements
   ("the bridge between Syabrubesi and Dhunche") resolves to neither. It is a location on an
   arc, not on a node. Return `null`.

## Step 5 - The confusable pairs that actually cause wrong matches

These are the ones to check every single time.

**Rivers and streams are not settlements.**
"Trishuli River" is not `Trishuli Bazar`. "Tadi Khola" is not the Tadi rural municipality.
"Likhu Khola" is not Likhu. A hydronym needs an accompanying settlement-level statement
("the Trishuli washed away the bazar at Betrawati") before any settlement resolves - and then
it is Betrawati that resolves, not the river.

**There are two Bhote Koshi rivers in Nepal, and they are not near each other.**

| | This corridor | A different disaster |
|---|---|---|
| River | Bhote Koshi → **Trishuli** | Bhote Koshi → **Sun Koshi** |
| District | Rasuwa | **Sindhupalchok** |
| Border point | Rasuwagadhi / Kyirong | **Kodari / Tatopani / Liping** |
| Highway | Pasang Lhamu Highway | **Araniko Highway** |
| Nearby names | Timure, Syabrubesi, Dhunche | **Barhabise, Melamchi, Jure, Listi, Chaku** |

A report headlined "Bhote Koshi flood" that mentions Barhabise, Tatopani, Kodari, Araniko or
Sindhupalchok **is about a different river system in a different district.** It resolves to
nothing here. Getting this wrong imports an unrelated event's coverage into this corridor and
silences real settlements.

**Devighat (Nuwakot) is not Devghat (Chitwan/Tanahun).** Devighat is the hydropower site just
below Bidur, at 27.902 N. Devghat is the religious confluence near Bharatpur, roughly 100 km
downstream past Mugling and Narayanghat. One letter apart. Different district, different
event footprint.

**"Thulo Syabru" is not "Thulogaun", and neither is "Syabrubesi".** Thulo Syabru is a village
on the hillside above the Langtang trail; it is **not in the gazetteer**. Character-similarity
matching loves `Thulo Syabru` → `Thulogaun` (shared "thulo") and `Thulo Syabru` → `Syabrubesi`
(shared "syabru"). Both are wrong. Thulogaun is at 85.196 E near Parbatikunda, nowhere near
Syabru. Return `null` for Thulo Syabru.

**"Rasuwagadhi" resolves to Timure. "Rasuwa" resolves to nothing.** These differ by four
characters and by an entire order of magnitude in specificity. Rasuwagadhi is the border
fort and customs yard about 2 km above Timure and is listed as a Timure alias; Rasuwa is the
district.

**"Trishuli" alone is ambiguous** between the river and Trishuli Bazar. Resolve to
`np-nuwakot-trishuli-bazar` only when the text treats it as an inhabited place ("shops in
Trishuli", "residents of Trishuli", "Trishuli bus park"). "The Trishuli rose four metres"
is the river.

**Betrawati straddles the district line.** The bridge at Betrawati *is* the Rasuwa/Nuwakot
boundary. Outlets file it under either district. Do not reject a Betrawati name match because
the article said "Rasuwa" - here alone, the district conflict is not disqualifying.

**Nuwakot the district vs Nuwakot the historic town.** The old durbar hill town is inside
Bidur municipality; the gazetteer carries it as the Bidur alias "Nuwakot Bazar". "Nuwakot
Durbar" is a specific site and resolves to Bidur at reduced confidence. Bare "Nuwakot" is the
district and resolves to nothing.

## Step 6 - Decision procedure

1. Normalize the candidate mention (step 1).
2. Exact match against every gazetteer name and alias. Hit → resolve, confidence 0.85-0.95.
3. Apply step 2 transliteration rules and match again. Hit → resolve, 0.7-0.85.
4. Check step 5. Any confusable triggered → `null`, and say which one in `why`.
5. Is the only place-level term a district, province, region or river? → `null`.
6. Does more than one settlement remain plausible? → `null`. Do not rank them and take the top.
7. Does a corridor direction word plus a named anchor leave exactly one candidate, and does the
   text describe a settlement-level observation? → resolve at 0.5-0.7.
8. Otherwise → `null`.

## Worked examples

| Input | Answer | Reason |
|---|---|---|
| "Syaphrubesi bazaar was swept away overnight" | `np-rasuwa-syabrubesi`, 0.82 | ph↔p variant, listed alias |
| "Dunche residents report the road is gone" | `np-rasuwa-dhunche`, 0.8 | aspiration-dropped variant, listed alias |
| "Betrabati bridge collapsed, Rasuwa" | `np-nuwakot-betrawati`, 0.85 | b↔w variant; boundary settlement, Rasuwa is not a conflict |
| "Massive flooding across Rasuwa district" | `null` | district only; nine candidates |
| "At least 389 dead in Rasuwa, Nuwakot and Dhading" | `null` | three districts, a national roll-up |
| "Timure Bazar cut off after the surge" | `np-rasuwa-timure`, 0.9 | listed alias |
| "Chinese dry port at Rasuwagadhi damaged" | `np-rasuwa-timure`, 0.85 | Rasuwagadhi is a Timure alias |
| "Bhote Koshi flood hits Barhabise" | `null` | Sindhupalchok Bhote Koshi, different river |
| "Thulo Syabru villagers walked out" | `null` | not in gazetteer; do not fuzzy-match to Thulogaun |
| "the Trishuli crested at 4 m above normal" | `null` | hydronym, no settlement-level claim |
| "shops in Trishuli reopened Thursday" | `np-nuwakot-trishuli-bazar`, 0.75 | treated as an inhabited place |
| "somewhere between Syabrubesi and Dhunche" | `null` | a location on an arc, not a node |
| "Uttargaya-4 remains unreachable" | `np-rasuwa-uttargaya`, 0.6 | ward inside a named unit |
| "Dhadingbesi hospital admitted 40" | `np-dhading-nilkantha`, 0.85 | Dhading Besi is the Nilkantha seat |
| "Devghat pilgrims stranded" | `null` | Devghat is in Chitwan, not Devighat in Nuwakot |
