# Bright Data SERP response shape — verified against the live API

Probed 2026-08-29 with a real token against zone `serp_api1`. This is ground truth for the
ingest parser: write against **this**, not against an assumed shape.

## Request

```bash
curl -s -X POST "https://api.brightdata.com/request" \
  -H "Authorization: Bearer $BRIGHTDATA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "zone": "serp_api1",
        "url": "https://www.google.com/search?q=Trishuli+flood+Nepal&tbm=nws&brd_json=1",
        "format": "raw"
      }'
```

Two query parameters do the real work:

- `tbm=nws` — restrict to Google News results
- `brd_json=1` — **required**. Without it Bright Data returns raw HTML and you have to parse
  Google's markup yourself. With it you get parsed JSON.

## Response

Top-level keys: `general`, `input`, `organic`, `news`, `navigation`.

For news queries the payload lives in `news[]` (10 items per page). Each item:

| field | type | notes |
|---|---|---|
| `title` | string | headline — usable directly |
| `description` | string | snippet, 1–2 sentences — this is the report body text |
| `source` | string | outlet name, e.g. `"The Guardian"` — maps to `Report.sourceName` |
| `date` | string | **relative**, e.g. `"2 days ago"`, `"16 hours ago"` — must be parsed |
| `link` | string | **NOT a usable URL** — see below |
| `global_rank` | number | Google's ordering |
| `source_logo` | string | base64 data URI — ignore, it is large |
| `image` | string | base64 data URI — ignore, it is large |

### Two traps

**1. `link` is a redirect stub, not a URL.** It comes back as
`/goto?url=CAESoQEB6zswFYhLMT9...` — a relative path with an opaque encoded payload, not the
publisher's address. Do not put it in `Report.url` unencoded.

Handle it as: `url = "https://www.google.com" + link`, and set a `resolvedUrl: null` field.
If a real publisher URL is needed, follow the redirect through the unlocker zone
(`BRIGHTDATA_UNLOCKER_ZONE`) and read the final address. For ranking purposes the resolved URL
is not required — `source` + `title` + `date` is enough to build a Report.

**2. `date` is relative, not ISO.** Parse `"N minutes|hours|days|weeks ago"` into a real
timestamp by subtracting from now. Anything unparseable should fall back to `fetchedAt` and
be flagged, never silently treated as "just now" — the whole ranking turns on report
timestamps, so a wrong timestamp is a wrong silence score.

Observed values in one real response: `"2 days ago"` (x7), `"3 days ago"` (x2),
`"16 hours ago"` (x1). Granularity is coarse — hours at best — which is worth stating honestly
in the UI rather than implying minute-level precision.

### Geographic note

`general.country` reflects the exit node's country (observed: `"Portugal"`), not the query
target. Add `&gl=np&hl=en` to the Google URL to bias results toward Nepal if coverage looks off.

## What live data actually returns

The event is real and current, so the SERP zone returns genuine coverage:

- The Guardian — "Nearly 1,400 missing, mostly tourists, after Nepal-Tibet flash flood kills at least 356"
- Al Jazeera — "Nepal-Tibet floods: What happened, what caused them and who is missing?"
- France 24 — "Deadly flash floods near Nepal-Tibet border raze villages, leave hundreds missing"
- DW, The Japan Times, The National — similar

These are national/international outlets writing about the disaster as a whole. They rarely name
individual settlements, which is exactly the project's point: **broad coverage of the event does
not mean coverage of every place inside it.** Settlement-level silence has to be searched for
per-settlement, so ingest should run one query per settlement name in addition to the
event-level query.

## Available zones on this account

```
web_unlocker1   unblocker
web_unlocker2   unblocker
serp_api1       serp
```

Refresh the list any time with:

```bash
curl -H "Authorization: Bearer $BRIGHTDATA_API_TOKEN" \
     https://api.brightdata.com/zone/get_active_zones
```
