# The Security & QA Hiring Bar (2026)

**What this is.** Research into what security-engineering and QA/test-engineering hiring managers
actually require in 2026, and what that means for Signal Zero. Written to be checkable: every
substantive claim below carries the URL it came from.

**Compiled:** 30 August 2026.

## How to read the evidence labels

Every claim is tagged. This matters more than usual because most of what is written about
"the 2026 testing landscape" and "OWASP LLM Top 10" online is SEO filler that paraphrases
primary sources inaccurately.

| Tag | Meaning |
|---|---|
| **[POSTING]** | Literal text from a real job posting I fetched. |
| **[PRIMARY]** | Published standard, spec, official docs, vendor engineering blog, or peer-reviewed/preprint paper I fetched. |
| **[SECONDARY]** | Reported by a news outlet or third-party analysis; the underlying primary source was not directly fetched. |
| **[SEARCH]** | Derived from search-result summaries only. Weakest tier. Treat as a lead, not a fact. |
| **[INFERENCE]** | My own reasoning. Not sourced. |
| **[UNVERIFIED]** | I looked and could not confirm it. Stated so you don't repeat it. |
| **[MEASURED]** | I ran a command against this repo and observed the result. |

### Things I could not verify — stated up front

- **Google's coverage thresholds (60% acceptable / 75% commendable / 90% exemplary).** My direct
  fetch of the Google Testing Blog post returned only page chrome, not the article body. The
  figures appear in the search summary of that post but I did not read them in the primary. See
  §9. **[UNVERIFIED]**
- **Google's flaky-test rates (commonly quoted as "1.5% of test runs" and "16% of tests").** I
  fetched three Google Testing Blog posts on flakiness and none of them contained those figures in
  the body I received. They are widely repeated online; I could not confirm them. See §8.
  **[UNVERIFIED]**
- **The CISA 2026 SBOM PDF.** Both the cisa.gov and media.defense.gov copies returned HTTP 403 to
  my fetcher. §2 reports what the landing pages and multiple analyses say, tagged accordingly.
- **Contract-testing adoption statistics.** Every result was marketing content quoting
  unattributable numbers ("80% of organizations…", "30–50% faster…"). I refuse to cite them. See §7.
- **Trail of Bits and Snyk posting text.** Their ATS pages did not render usable content for my
  fetcher; §1/§2 use search-level summaries and label them **[SEARCH]**.
- **Salary bands** beyond the one posting that stated its own range. I invented none.

---

# PART ONE — SECURITY

## 1. AI / LLM security

### 1.1 The list changed three weeks before this was written

This is the single most important accuracy point in the document. **The OWASP list you may
remember is out of date.** The OWASP GenAI Security Project published a new edition on
**4 August 2026**.

**The current list — OWASP Top 10 for LLM Applications 2026 [PRIMARY]**
Source: <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> (CC BY-SA 4.0)

| ID | Title |
|---|---|
| LLM01:2026 | Prompt Injection |
| LLM02:2026 | Sensitive Information Disclosure |
| LLM03:2026 | Excessive Agency |
| LLM04:2026 | Supply Chain |
| LLM05:2026 | Data and Model Poisoning |
| LLM06:2026 | Unbounded Consumption |
| LLM07:2026 | Misinformation |
| LLM08:2026 | Hidden Context Exposure |
| LLM09:2026 | Vector and Embedding Weaknesses |
| LLM10:2026 | Improper Output Handling |

**The superseded 2025 list, for contrast [PRIMARY]** — <https://genai.owasp.org/llm-top-10/>
LLM01 Prompt Injection · LLM02 Sensitive Information Disclosure · LLM03 Supply Chain ·
LLM04 Data and Model Poisoning · LLM05 Improper Output Handling · LLM06 Excessive Agency ·
LLM07 System Prompt Leakage · LLM08 Vector and Embedding Weaknesses · LLM09 Misinformation ·
LLM10 Unbounded Consumption.

**What moved, and why it matters [SECONDARY]**
Reported by Help Net Security, 6 August 2026
(<https://www.helpnetsecurity.com/2026/08/06/owasp-2026-llm-top-10-released/>):

- Excessive Agency made the largest jump, LLM06 → LLM03.
- Improper Output Handling fell hardest, LLM05 → LLM10.
- Unbounded Consumption rose four places, LLM10 → LLM06.
- Misinformation rose two places, LLM09 → LLM07.
- **System Prompt Leakage was replaced by Hidden Context Exposure** — a broader category.
- Methodology changed: the ranking is reported as 75% practitioner vote and 25% weighted by data
  from 6,639 real incidents.

I cross-checked every one of those five movements against the 2026 list from the OWASP GitHub
repo above. All five are arithmetically consistent with it. Two independent sources agree.

The project leads' framing, as quoted by Help Net Security, is the thesis a candidate should be
able to defend: build the system so that when the model is fooled, nothing important breaks.

### 1.2 The companion list that fits this project better

OWASP also publishes **Top 10 for Agentic Applications** (ASI01–ASI10). The resource page gives a
publication date of 9 December 2025 and it was announced at Black Hat Europe 2025.
Sources: <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/> and,
for the entry list, <https://auth0.com/blog/owasp-top-10-agentic-applications-lessons/> and
<https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/> — two independent sources that agree
on all ten. **[PRIMARY for existence/date, SECONDARY for the entry list]**

ASI01 Agent Goal Hijack · ASI02 Tool Misuse & Exploitation · ASI03 Identity & Privilege Abuse ·
ASI04 Agentic Supply Chain Vulnerabilities · ASI05 Unexpected Code Execution ·
ASI06 Memory & Context Poisoning · ASI07 Insecure Inter-Agent Communication ·
ASI08 Cascading Failures · ASI09 Human-Agent Trust Exploitation · ASI10 Rogue Agents.

**[INFERENCE]** For a five-agent system with an MCP tool surface and a human approval step, the
ASI list is the more precise instrument, and citing it signals you read past the headline list.
ASI09 in particular — Human-Agent Trust Exploitation — is directly about the approval UI.

### 1.3 Which entries apply to Signal Zero

Signal Zero scrapes untrusted web content and feeds it to a model. That is the canonical exposure.

| Risk | Applies? | Why, specific to this system |
|---|---|---|
| **LLM01 Prompt Injection** | **Directly** | Scraped news/social text reaches a tier-3 classification prompt. Indirect injection, the harder variant. |
| **LLM03 Excessive Agency** | **Directly** | 5 registered agents, 5 Bright Data MCP tools. Agency is the product. |
| **LLM04 Supply Chain** | **Directly** | Self-hosted third-party harness (TrueForge), an MCP server, npm deps, and a remote model provider. |
| **LLM07 Misinformation** | **Directly, and severely** | The output is a ranked list that a responder might act on. A wrong silence ranking sends people to the wrong valley. This is the highest-consequence risk in the system and it is *not* prompt injection. |
| **LLM10 Improper Output Handling** | **Directly** | Model output flows into ranking logic and into a browser DOM. |
| **LLM08 Hidden Context Exposure** | Partly | Agent instructions live in the TrueForge registry, not the repo. |
| **LLM06 Unbounded Consumption** | Partly | A 114s pipeline pass with a tier-3 timeout is already a resource-behaviour finding. |
| **LLM02 Sensitive Information Disclosure** | Weakly | No PII store today; scraped content could contain it. |
| **LLM05 Data and Model Poisoning** | Weakly | No training or fine-tuning. Corpus poisoning is the near-neighbour and is real. |
| **LLM09 Vector and Embedding Weaknesses** | **No** | No vector store, no RAG retrieval. Say so; claiming it would be padding. |

Agentic mappings that also land: **ASI01** (goal hijack via scraped text), **ASI02** (tool misuse
through the MCP surface), **ASI06** (context poisoning — the corpus *is* the context),
**ASI09** (trust exploitation at the approval step).

### 1.4 What a credible defence looks like

The honest starting position, which is now well-evidenced:

**[PRIMARY]** *The Attacker Moves Second: Stronger Adaptive Attacks Bypass Defenses Against LLM
Jailbreaks and Prompt Injections* — arXiv 2510.09023, a collaboration involving researchers from
OpenAI, Anthropic and Google DeepMind. The authors bypassed 12 recent published defences with
attack success rates above 90% for most of them, where the original papers had reported near-zero
success. <https://arxiv.org/abs/2510.09023>

**[SECONDARY]** Gray Swan benchmark figures for Claude Opus 4.5, as reported by The Decoder on
25 November 2025: 4.7% attack success at one attempt, 33.6% at ten, 63% at one hundred.
<https://the-decoder.com/claude-opus-4-5-resists-prompt-injections-better-than-rivals-but-still-falls-to-strong-attacks-alarmingly-often/>
*Caution:* secondary reports disagree on the comparative figures for rival models — one search
summary gave Gemini 3 Pro 12.5% and GPT-5.1 21.9%, while The Decoder reports rival rates "as high
as 92 percent," almost certainly at a different attempt count. I am not citing the rival numbers
because I could not reconcile them. The Opus trend line is the point: **defences degrade sharply
under repeated attempts.**

**[PRIMARY]** Simon Willison's *lethal trifecta*, 16 June 2025: access to private data + exposure
to untrusted content + ability to externally communicate. The mitigation is architectural
avoidance of the combination, not better guardrails.
<https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/>

**[PRIMARY]** Thoughtworks Technology Radar Vol. 34, April 2026 lists **Toxic Flow Analysis for
AI** — analysing agentic systems for unsafe data paths — and places **MITRE ATLAS** in Assess as a
threat taxonomy for ML pipelines and agentic systems.
<https://www.thoughtworks.com/radar/techniques>

**So a defence that a security engineer will respect looks like this [INFERENCE, built on the above]:**

1. **Architectural containment first.** State plainly where the trifecta is broken. Signal Zero's
   strongest available claim is that the model has *no write authority*: tier 3 returns a
   classification, and ranking is deterministic statistics. If that is true, say it precisely and
   point at the code — that is a stronger security argument than any filter.
2. **Guardrails as defence-in-depth, never as the boundary.** The repo already has deterministic
   guardrail code rather than prompt text, which is the right shape. Do not claim it *prevents*
   injection; claim it *detects and blocks specific observed classes*, and name them
   (`injection.invisible-characters` is a real, citable observation).
3. **Least agency, explicitly.** Enumerate the 5 tools, the allowed operations, and what is behind
   the human approval gate. The verified `tool.approval_required → user.tool_approval →
   tool.response` sequence is exactly the artefact ASI03/LLM03 asks for.
4. **Adversarial evals in CI, with a documented failure rate.** The repo has adversarial
   prompt-injection evals. The credible move is to publish the *pass rate*, not a pass/fail
   badge — and to run more than one attempt per case (see §8 and the arXiv finding above).
5. **Failure-mode honesty.** Given the paper above, any claim of "protected against prompt
   injection" is a red flag to an interviewer. "Contained, monitored, and measured, with a known
   residual" is the defensible claim.

### 1.5 What postings literally ask for

**[POSTING]** Cloudflare, *Product Security Engineer* (Austin / London) —
<https://job-boards.greenhouse.io/cloudflare/jobs/8102768>
Responsibilities include conducting security assessments and threat modelling exercises
"(such as STRIDE)" across product features; product vulnerability lifecycle management against
SLAs; bug bounty technical triage; pentest coordination. Desired: 5+ years in product or
application security in large-scale distributed cloud/SaaS; demonstrated ability to build
production-grade automation leveraging AI/LLMs; competency in threat-modelling methodologies.
*Note the AI-automation requirement sitting inside a classic AppSec role — that is new.*

**[POSTING]** Chainguard, *Security Engineer* (US Remote, $105,000–$123,000) —
<https://job-boards.greenhouse.io/chainguard/jobs/4700281006>
An explicitly earlier-career role. Requires a strong IT-administration **or** software-development
foundation plus hands-on work in at least one of IAM, AI/ML infrastructure, or cloud (GCP/AWS/
Azure). Responsibilities include contributing to safeguarding AI/ML workflows **and agentic
systems**. Security knowledge is *preferred*, not required. No years-of-experience figure stated.

**[INFERENCE]** That second posting is the load-bearing one for a job-seeker. A recognised
supply-chain security company is hiring into security from software engineering, asks for depth in
*one* area rather than all three, and names agentic systems as in-scope. A portfolio project that
demonstrably secures an agentic system is aimed directly at this opening.

**[SEARCH]** Trail of Bits security-engineer roles emphasise strong software development (Rust,
C++, Python), knowledge of AI/ML systems and their security challenges, and a willingness to write
publicly. <https://trailofbits.com/careers/> — I could not fetch the posting bodies; treat as a
lead. The public-writing expectation is consistent with their well-known blog-first culture.

**[SEARCH]** Snyk application-security-adjacent roles reference familiarity with AI-native
application security concerns including agentic systems, MCP, and LLM supply-chain risk.
<https://snyk.io/careers/> — posting body not fetched.

---

## 2. Supply chain

### 2.1 The standards, stated accurately

**SLSA [PRIMARY]** — <https://slsa.dev/spec/v1.0/levels>. Note: **v1.0 is marked retired; v1.2 is
the active specification.** Getting this wrong in an interview is exactly the kind of stale-knowledge
tell that costs a candidate. Build levels:

- **L0** — no guarantees.
- **L1** — provenance exists, describing build platform, process, and top-level inputs.
- **L2** — builds run on a hosted platform on dedicated infrastructure; provenance is signed.
- **L3** — hardened builds; runs cannot influence one another; signing secrets are inaccessible to
  user-defined build steps.

**GitHub artifact attestations [PRIMARY]** —
<https://docs.github.com/en/actions/concepts/security/artifact-attestations>. Attestations bind an
artifact and its digest to a SLSA build-provenance predicate in in-toto format, signed with a
short-lived Sigstore certificate. **They provide SLSA v1.0 Build Level 2 by default**; Build L3
needs reusable workflows to isolate the build from the calling workflow. Consumers verify with
`gh attestation verify`. The docs are explicit that attestations are *not* a guarantee the artifact
is secure — they link it to source and build instructions.

**SBOM [SECONDARY — PDF fetch blocked 403]** — CISA and partner agencies published **2026 Minimum
Elements for a Software Bill of Materials on 29 July 2026**, the first full update to the NTIA 2021
baseline. Landing page: <https://www.cisa.gov/resources-tools/resources/2026-minimum-elements-software-bill-materials-sbom>.
Multiple independent analyses agree on the substance: **CycloneDX and SPDX are now the named
acceptable machine-processable formats and SWID tags were removed**; roughly ten new data fields
were added, including component hash algorithm and value, component licence, SBOM tool name, SBOM
generation context, and an SBOM author signature; "known unknowns" became explicit identification
of unknown information; scope now covers open source, AI systems, and SaaS.
Corroborating analyses: <https://runsafesecurity.com/blog/sbom-minimum-elements-cyclonedx-spdx/>,
<https://www.opswat.com/blog/cisas-2026-sbom-minimum-elements-now-require-post-build-data>.
*Because I could not read the PDF, treat exact field names as high-confidence-but-secondary.*

**OpenSSF Scorecard [PRIMARY]** — <https://github.com/ossf/scorecard>. Relevant checks and their
risk weightings: Branch-Protection (high), Token-Permissions — workflow tokens read-only (high),
Signed-Releases (high), Dependency-Update-Tool (high), Pinned-Dependencies (medium), CI-Tests (low),
plus checks for security policy, code review, binary artifacts and vulnerabilities.

### 2.2 Table stakes for a public repo

**[INFERENCE, grounded in the Scorecard check list and the SLSA/GitHub docs above]** Scorecard is
the most useful proxy for "table stakes" because it is a published, machine-checkable rubric that a
reviewer can run against your repo in one command. Ranked by what a reviewer will notice first:

**Table stakes**
- CI that runs tests on every PR. Scorecard's CI-Tests check. Signal Zero has 195 tests and **no CI
  to run them** — this is the single largest credibility gap in the repo. **[MEASURED: no
  `.github/workflows`]**
- A lockfile, committed. **[MEASURED: `package-lock.json` is present and tracked by git — this one
  is already satisfied. The remaining half is that CI must use `npm ci`, not `npm install`.]**
- Automated dependency updates (Dependabot or Renovate config).
- Workflow `permissions:` set to least privilege — Scorecard Token-Permissions, high risk.
- Branch protection on the default branch.
- A `LICENSE` file. **[MEASURED: absent.]** For a public repo this is not a nicety; without it the
  code is not legally reusable, and a supply-chain-literate reviewer will register that instantly.
- A `SECURITY.md`. **[MEASURED: absent.]**

**Differentiators**
- Generating a CycloneDX or SPDX SBOM in CI and attaching it to releases — and, better, saying
  *which* CISA 2026 elements your SBOM does and does not carry.
- `actions/attest-build-provenance` for signed provenance → SLSA Build L2 by construction, and
  documenting the `gh attestation verify` command a consumer would run.
- Pinning GitHub Actions to commit SHAs rather than tags.
- Signed commits. **[INFERENCE]** Modest security value on a solo repo, high signal value: it shows
  you know the difference between authorship metadata and authorship proof.

**[INFERENCE]** The high-leverage move for Signal Zero specifically is not the SBOM. It is that
this project has an unusual supply chain worth *documenting*: a self-hosted third-party agent
harness, an MCP server, and a remote model provider. A one-page "what code and what instructions
execute in this system, and where each comes from" is more interesting than a generated SBOM,
because almost nobody writes it, and it directly addresses LLM04 and ASI04.

---

## 3. Secrets

### 3.1 What is expected

**[PRIMARY]** GitHub push protection is enabled by default for all public repositories, and scans
during the push, blocking detected secrets.
<https://docs.github.com/en/code-security/secret-scanning/working-with-secret-scanning-and-push-protection/remediating-a-leaked-secret>

**[SECONDARY]** GitGuardian's analysis of push protection's limits: it does not scan history, so
credentials committed before it was enabled remain until found by historical scanning; the standard
remediation order is **revoke/rotate first, rewrite history second, investigate use third**.
<https://blog.gitguardian.com/github-push-protection-enhancing-open-source-security-with-limitations-to-consider/>

**[INFERENCE]** The expected stack in 2026 is three layers, and a reviewer will look for all three:
a pre-commit hook (gitleaks or trufflehog) so it never leaves the laptop; push protection at the
forge; and a CI job that scans **full history**, not just the diff. The third is the one candidates
skip and the one that actually proves something.

### 3.2 What a reviewer would want to see for *this* repo — and what is already true

The question was: this project has real API keys in a gitignored `.env`; what proves nothing ever
leaked into history? I ran the checks. **[MEASURED, 30 Aug 2026, on branch `feat/control-room-ux`]**

- `git log --all -- ':(literal).env'` → **no commits.** `.env` has never been committed on any
  branch or ref reachable from `--all`.
- Every path ever added across all history: **82 files**, of which the only env-adjacent one is
  `.env.example`.
- Total commits across all refs: **10**. A small, fully auditable history.
- `git grep` across all commits for `sk-ant-`, `sk-…`, `AKIA…`, `ghp_…`, `brd_`, and PEM private-key
  headers returned **only false positives**: every `brd_` hit is the Bright Data `brd_json=1` URL
  query parameter in `src/pipeline/ingest.js` and `docs/brightdata-serp-shape.md`. No credential
  material.
- `.env.example` is committed and **every secret value in it is empty** (`BRIGHTDATA_API_TOKEN=`,
  `OPENAI_API_KEY=`). Only non-secret defaults carry values (`PORT`, zone *names*, base URLs, model
  names). This is the correct pattern.
- `.gitignore` covers `.env` and `.env.local`.

**[INFERENCE]** So the repo is already clean. The gap is not hygiene, it is **provable** hygiene.
A reviewer will not run those commands; they will look for evidence you did. What to add:

1. A history-scanning CI job — `gitleaks detect --no-git=false` or equivalent — that scans the full
   history on every run, so the clean result is asserted continuously rather than claimed once.
2. A pre-commit hook, committed to the repo so it is visible.
3. A short paragraph in `SECURITY.md` stating the scan was run over full history, what it covered,
   and the result. **[INFERENCE]** Two sentences here beat a page of prose elsewhere: it shows you
   know that "we use .gitignore" is not an answer to "did anything ever leak."
4. Key rotation: state the rotation story honestly. For a portfolio project with personal keys,
   the credible claim is "keys are personal, unshared, and revocable from the provider dashboard;
   no rotation schedule is enforced," not an invented policy.

**[MEASURED, notable]** `.env.example` documents that TrueForge model-provider credentials "live in
TrueForge, not in this file." That is a real secrets-boundary decision already made in the design.
It is worth naming explicitly — it is a small piece of genuine architecture, not documentation.

---

## 4. Threat modelling

### 4.1 Is a written threat model expected in a portfolio project?

**[INFERENCE — labelled clearly, because I found no source that states an expectation for
*portfolio* projects specifically.]** I found no published hiring guidance saying portfolio
projects must contain a threat model. What I can evidence is that threat modelling is a named,
literal duty in security-engineering postings:

- **[POSTING]** Cloudflare Product Security Engineer: conduct threat modelling exercises
  "(such as STRIDE)"; competency in threat-modelling methodologies is a listed qualification.
  <https://job-boards.greenhouse.io/cloudflare/jobs/8102768>
- **[SEARCH]** HashiCorp product-security team descriptions list design review, threat modelling,
  code review and vulnerability management as the team's remit.

So: not *expected* in the sense of being a checkbox, but it is **the artefact that most directly
demonstrates a skill the postings name**, and almost no portfolio project has one.
**[INFERENCE]** That combination — high signal, low prevalence — is the definition of a
differentiator. For an agentic system that ingests untrusted content, I would rank it as the
highest-value security document you can write.

### 4.2 STRIDE, stated accurately

**[PRIMARY]** Microsoft Threat Modeling Tool documentation, part of the Microsoft SDL.
<https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats>
(page `ms.date` 2017-08-17, last updated 2026-03-04).

| Category | Microsoft's description, condensed |
|---|---|
| **Spoofing** | Illegitimately accessing and using another user's authentication information. |
| **Tampering** | Malicious modification of data — at rest in a store, or in flight between systems. |
| **Repudiation** | A user denies performing an action and no party can prove otherwise; non-repudiation is the countermeasure. |
| **Information Disclosure** | Exposure of information to those not authorised to see it. |
| **Denial of Service** | Denying service to valid users; an availability and reliability concern. |
| **Elevation of Privilege** | An unprivileged user gains privileged access, potentially becoming part of the trusted system. |

**Accuracy notes that separate real knowledge from a memorised acronym [INFERENCE]:**
- STRIDE is a *threat taxonomy*, not a methodology on its own. It is applied against a data-flow
  diagram with trust boundaries. A "threat model" that is a STRIDE table with no DFD and no trust
  boundaries is not a threat model.
- The one-to-one pairing with security properties (spoofing↔authentication, tampering↔integrity,
  repudiation↔non-repudiation, information disclosure↔confidentiality, DoS↔availability,
  EoP↔authorisation) is a real and useful mnemonic, but the Microsoft page above describes the
  threats rather than presenting that mapping as a table — do not attribute the table to Microsoft.
- STRIDE predates ML systems and does not natively cover model-specific threats. That is what
  **MITRE ATLAS** is for; Thoughtworks Radar Vol. 34 (April 2026) places ATLAS in **Assess** as a
  threat taxonomy for ML pipelines, LLM applications and agentic systems.
  <https://www.thoughtworks.com/radar/techniques>

### 4.3 What a credible one looks like for Signal Zero

**[INFERENCE]** Roughly two pages, containing:

1. **A data-flow diagram with explicit trust boundaries.** The boundaries that matter here:
   the public internet → scraper; scraped corpus → tier-3 prompt; TrueForge harness ↔ this app;
   MCP tool surface; browser ↔ API; the human approval step.
2. **STRIDE applied per boundary**, with the ML-specific threats added from ATLAS / the OWASP
   agentic list rather than forced into STRIDE categories where they do not fit.
3. **Assumptions and non-goals, stated.** "No authentication; single-operator deployment on
   localhost" is a legitimate entry in a threat model. It is not legitimate as a silence.
4. **The residual-risk table.** What you accepted, and why. This is the section that reads as
   engineering judgement rather than as a checklist.
5. **Repudiation gets real treatment**, because of §5 below. In a system whose selling point is
   that a named human approved an irreversible action, repudiation is not a box to tick — it is
   the core of the product claim.

---

## 5. AuthN / AuthZ — the honest argument

The system currently has none. **[MEASURED: confirmed absent.]** The question is whether a
documented threat model plus a clear boundary suffices, or whether real auth is necessary.

### The case that a documented boundary suffices

**[INFERENCE]** Real, and stronger than it first appears:

- Building a login form on a single-operator demo is not an interesting engineering exercise. It
  adds surface without adding insight, and reviewers can tell the difference between security work
  and security theatre.
- A deployment model of "single operator, localhost, no listener on a public interface" is a
  legitimate, statable trust boundary. Threat models are allowed to have scope.
- **[PRIMARY]** OWASP ASVS is explicitly tiered, which is the standards world conceding that not
  every application needs L2/L3 controls. ASVS 5.0 was released May 2025 with roughly 350
  requirements across 17 chapters; Level 1 carries about 70. Multi-factor requirements begin at L2,
  not L1. <https://github.com/OWASP/ASVS> **[SEARCH for the specific counts — I did not fetch the
  chapter files directly; the ASVS repo is the authoritative source.]**

### The case that this specific system needs more

**[INFERENCE, but grounded in ASI03/ASI09 and the repudiation category above]** And this is the
side I think is correct:

The project's headline claim is *"a named human approves an irreversible action."* That sentence
contains the word **named**. With no identity system, the system cannot name anyone. The approval
record says an approval happened; it cannot say who approved. That is precisely the **Repudiation**
category in §4.2 and **ASI09 Human-Agent Trust Exploitation** in §1.2 — and it is a gap in the
*product thesis*, not merely in the deployment posture.

**[PRIMARY-adjacent, SECONDARY]** The Auth0 analysis of the OWASP agentic list argues for managed
per-agent identity — each agent with its own client ID and credentials so audit logs can attribute
actions — task-scoped short-lived tokens, and centralised revocation.
<https://auth0.com/blog/owasp-top-10-agentic-applications-lessons/> This is vendor-authored content
about a market the vendor sells into; weight it accordingly. The underlying point — that agent
actions need attributable identity — is independently supported by ASI03 being in the top three.

### The minimum credible identity story

**[INFERENCE]** Not a login system. An **attribution** system. In rough order of value per unit of
effort:

1. **An append-only, hash-chained approval log.** Every approval record carries: approver
   identifier, timestamp, the exact action approved, the state hash it was approved against, and a
   hash of the previous record. This gives you non-repudiation *of the record's integrity* without
   any authentication at all, and it is genuinely interesting engineering.
2. **A stated operator identity, injected at deploy time** — an env var, or an
   `X-Operator` header terminated at a reverse proxy. Document that the trust boundary is the
   proxy, and that the app trusts it. **This is the honest minimum:** the app is not authenticating
   anyone, it is *recording who the deployment says is present*, and the threat model says so in
   those words.
3. **Per-agent identity in the audit trail.** Which of the 5 agents took which action. This costs
   little — the harness already emits per-turn telemetry — and maps directly onto ASI03.
4. **A written authorization matrix**: which agent may invoke which of the 5 MCP tools, which
   actions require human approval, and which are irreversible. This is a document, not code, and it
   is the artefact LLM03 Excessive Agency is asking for.

**Only then**, if it is worth it: real authentication. **[INFERENCE]** OIDC via a hosted provider
would take an afternoon and would let you delete the caveat in step 2. My honest read is that it is
worth doing *if and only if* the project is also deployed publicly — a public URL with no auth on
an approval endpoint is a finding any security reviewer will raise in the first five minutes, and
no threat model rescues it. On localhost, steps 1–4 plus a scoped threat model is a defensible and
more interesting answer.

**The thing not to do [INFERENCE]:** claim the approval step provides accountability while having
no identity at all. A security reviewer will find that in under a minute, and an overclaim found is
worse than a gap disclosed.

---

# PART TWO — QA / TESTING

## 6. The testing pyramid in 2026

### The state of the argument

**[PRIMARY]** Martin Fowler's *TestPyramid*, 1 May 2012, last revised 15 November 2017. The
argument is that far more automated testing should go through unit tests than through GUI-based
tests, because UI-driven tests are brittle, expensive and slow. **Notably, the original article
gives no numeric ratios** — only "many more" at the base.
<https://martinfowler.com/bliki/TestPyramid.html>

**[INFERENCE]** This matters: the specific ratios people quote as "the pyramid" (70/20/10 and
similar) are not from the source. Knowing that the canonical article contains no numbers is a small
but real credibility marker.

### Has it been displaced?

**Honest answer: no, and the sources disagree about how much it has been supplemented.** I am
reporting the disagreement rather than averaging it.

- **[SEARCH]** Search results split. Some argue the pyramid remains the most widespread practice;
  others argue teams have moved to trophy, honeycomb, or risk-based models; several argue for
  hybrids — pyramid-shaped for domain logic, trophy-shaped for API layers. Almost all of these
  results were SEO content of low evidential value, and I am not citing individual ones as
  authority. The one defensible conclusion from that corpus is that **there is no consensus
  replacement**.
- **[PRIMARY]** Thoughtworks Technology Radar Vol. 34, April 2026 — the most credible periodic
  read on industry practice I could fetch — does **not** carry a blip displacing the pyramid. Its
  testing-adjacent entries are mutation testing (Trial), feedback sensors for coding agents (Trial),
  LLM evaluation using semantic entropy (Assess). <https://www.thoughtworks.com/radar/techniques>
  **[INFERENCE]** The absence of a "testing trophy" blip is weak evidence, but it is evidence that
  the shape-of-the-pyramid debate is not where the industry's attention currently sits. The Radar's
  Vol. 34 framing, per Thoughtworks' own announcement, is a return to engineering fundamentals
  against AI-driven complexity.
  <https://www.thoughtworks.com/about-us/news/2026/combat-ai-cognitive-debt-radar-v34>

### What ratio do teams actually target?

Most sources give aspirational ratios with no data behind them. **One real published measurement**
is worth more than all of them:

**[PRIMARY]** GitLab publishes its own measured test distribution, stated as of February 2025:

| Level | Share of GitLab's suite |
|---|---|
| Unit | 75.66% |
| Integration | 19.79% |
| White-box system / feature | 4.31% |
| Black-box end-to-end | **0.24%** |

<https://docs.gitlab.com/development/testing_guide/testing_levels/>

**[INFERENCE]** That last row is the interesting one and the one to quote in an interview. A large,
mature, heavily-tested product runs end-to-end tests at roughly *one quarter of one percent* of its
suite. The practical guidance that follows is not "target 70/20/10" — it is that E2E tests are so
expensive that a serious organisation keeps them near-vestigial and pushes confidence downward.

**A structural note on the industry [PRIMARY, and a genuinely useful signal]:** GitLab's
Software-Engineer-in-Test job family page now carries a deprecation notice — the role was
transitioned into Backend Engineer, and candidates interested in testing are directed to the
Backend Engineer family.
<https://handbook.gitlab.com/job-description-library/engineering/software-engineer-in-test/>
The Backend Engineer family requires developing features "in a secure, well-tested, and performant
way" as a core responsibility.
<https://handbook.gitlab.com/job-families/engineering/backend-engineer/>

**[INFERENCE]** For a job-seeker this is the most actionable structural fact in Part Two: at least
at GitLab, testing is not a separate career track to apply into — it is an expectation folded into
the engineering role. That argues against positioning Signal Zero as "a QA portfolio project" and
for positioning testing rigour as an attribute of an engineering portfolio project. It is one
company's decision, not an industry-wide law, and should be cited as such.

---

## 7. Property-based, mutation, contract testing, fuzzing

**Which are expected, which are rare and impressive?**

| Technique | Status | Evidence |
|---|---|---|
| **Mutation testing** | Rising, not yet default. **Impressive.** | **[PRIMARY]** Thoughtworks Radar Vol. 34, April 2026: ring = **Trial** ("worth pursuing"), *not* Adopt. <https://www.thoughtworks.com/radar/techniques/mutation-testing> |
| **Property-based testing** | Rare in postings. **Impressive.** | **[SEARCH]** Searches of 2026 QA/SDET postings surfaced Playwright, Selenium, Cypress, API and regression testing; property-based testing did not appear. Weak evidence — absence in search results is not absence in the market. |
| **Contract testing** | Standard *for multi-service architectures*. Not applicable here. | **[UNVERIFIED]** Every adoption statistic I found was marketing content with unattributable figures. I am not citing them. |
| **Fuzzing** | Expected in security engineering, rare in app QA. | **[SEARCH]** Trail of Bits-style security-tooling roles emphasise low-level analysis and security tooling; fuzzing is native to that world. |

### The correction worth making

**[PRIMARY, and this is a direct disagreement between sources]** A search summary asserted that the
April 2026 Thoughtworks Radar classifies mutation testing at **"adopt-level."** I fetched the Radar
blip itself: it is in **Trial**. The secondary source overstated it. Reporting mutation testing as
"Adopt per Thoughtworks" would be repeating an error that a well-read interviewer might catch.

The Radar's rationale is the part that matters for this project: unlike coverage, which tracks line
execution, mutation testing introduces deliberate bugs to verify tests fail when behaviour breaks —
and this distinction sharpens in an era of AI-assisted development, where high coverage percentages
can mask logically hollow generated tests.

### What this means for Signal Zero

**[INFERENCE]**

- **Mutation testing is the highest-value differentiator available in Part Two.** It is in Trial on
  the Radar, near-absent from portfolios, tooled in JS (Stryker), and — crucially — it *directly
  answers* the strongest critique of the project's headline "195 tests" number. A candidate who
  says "195 tests, and here is the mutation score that shows they actually assert things" has
  pre-empted the obvious challenge.
- **Property-based testing is already partly there.** The repo has "deterministic property tests"
  in the eval suite. Signal Zero has unusually good targets for real PBT: Fellegi–Sunter record
  linkage (symmetry, monotonicity in log-likelihood), the Exponential/Gamma time-between-events
  baseline (invariants under time rescaling), and Getis-Ord Gi* (permutation invariance, behaviour
  on a null field). Those are genuine mathematical invariants, not contrived ones. `fast-check` is
  the JS tool. **This is a strong fit and probably under-exploited.**
- **Contract testing: skip it, and say why.** Signal Zero is a monolith. Introducing Pact would be
  résumé-driven development, and an experienced reviewer will read it that way. "Not applicable —
  single deployable, no independent consumers" is the better answer.
- **Fuzzing: narrow and worthwhile.** Not whole-system fuzzing. Fuzz the parsers — the Bright Data
  SERP/JSON response handling in `src/pipeline/ingest.js`, which parses hostile-by-assumption input
  from the open web. That is a *security*-motivated fuzz target, which makes it count in both
  disciplines at once.

---

## 8. Testing non-deterministic systems — the hard one

This is the section that can differentiate the project, because the ground truth is genuinely
unsettled and most portfolios do not engage with it at all.

### 8.1 The foundational fact most people get wrong

**Temperature 0 does not give you determinism.**

**[PRIMARY]** Thinking Machines Lab, *Defeating Nondeterminism in LLM Inference*
(<https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/>) identifies the
mechanism: individual GPU kernels are deterministic, but LLM inference is nondeterministic at the
*system* level because kernel output depends on batch size — a property they call **batch
invariance**. Matmul, RMSNorm and attention produce different floating-point accumulation orders at
different batch sizes, and production batch size fluctuates with server load. Their remedy is
batch-invariant kernels; they demonstrate Qwen3-8B running deterministically under vLLM.
Independent summary: <https://simonwillison.net/2025/Sep/11/defeating-nondeterminism/>

**[INFERENCE]** Practical consequence for a portfolio project: **you cannot make a hosted API
deterministic from the client side.** Any claim of "we set temperature to 0 so it's deterministic"
is wrong, and this is a good thing to know precisely, because it is a common and confidently-stated
error. The only client-side route to determinism is to stop calling the model — which is what
recorded replay does.

**[PRIMARY]** Song, Wang, Li & Lin, *The Good, The Bad, and The Greedy: Evaluation of LLMs Should
Not Ignore Non-Determinism*, arXiv 2407.10457 (submitted 15 July 2024). Finds greedy decoding
generally outperforms sampling across most evaluated tasks, that the advantage holds across model
sizes and alignment techniques, that alignment reduces sampling variance, and that best-of-N lets
smaller models match or surpass much larger ones. <https://arxiv.org/abs/2407.10457>
**[INFERENCE]** The methodological lesson: single-sample evaluation systematically misreports
capability. If your eval runs each case once, you are measuring one draw from a distribution and
reporting it as a point estimate.

### 8.2 State of the art, as best I can evidence it

**[PRIMARY]** Anthropic's published eval guidance
(<https://platform.claude.com/docs/en/test-and-evaluate/eval-tool>) documents three grading
families and a clear design stance:

- **Code-based / exact match** — for categorical outputs. Simple and unambiguous.
- **LLM-based grading** — Likert scales, binary classification, ordinal scales, for subjective
  criteria. Best practice noted: use a *different* model to grade than the one being graded.
- **Similarity / reference-based** — cosine similarity over embeddings, ROUGE-L, where wording
  varies but meaning should not.

Design principles: be task-specific and include edge cases (typos, sarcasm, rambling input,
irrelevant information, ambiguity); automate grading wherever possible; define success criteria up
front as specific and measurable (their example: not "good performance" but an F1 threshold). And a
principle worth quoting because it is counterintuitive: they advise prioritising volume over
per-case grading quality — more cases with slightly weaker automated grading beats fewer
hand-graded ones.

**[PRIMARY]** Thoughtworks Radar Vol. 34 places **LLM evaluation using semantic entropy** in
**Assess** — evaluating meaning rather than word sequences, using semantic variation across
outputs to detect confabulation. <https://www.thoughtworks.com/radar/techniques>
**[INFERENCE]** "Assess" is the right ring to cite it from: it means promising and worth
understanding, not proven. Presenting it as established practice would be an overclaim.

**[SEARCH]** A recurring engineering consensus across 2026 write-ups — none individually
authoritative enough to cite as fact, but consistent with the primaries above: golden sets should
be composed of stratified production samples, an adversarial library, constructed edge cases and
replays of shipped failures; assert on semantic equivalence rather than byte-exact match; run N
rollouts per scenario rather than one.

### 8.3 The technique ladder, ordered by rigour

**[INFERENCE, synthesised from the primaries above]** From weakest to strongest:

1. **Snapshot / golden tests on model output.** Weakest. Byte-exact snapshots of generated text are
   flaky by construction (§8.1) and will be deleted or `--update`-ed into meaninglessness within a
   month. **Only defensible when snapshotting a *structured, constrained* output** — a
   classification label, a JSON schema instance — not prose.
2. **Deterministic replay of recorded model responses.** Record real API responses once, commit
   them as fixtures, replay in CI. This is the single highest-value technique for a project like
   Signal Zero, because it makes the *pipeline around the model* fully deterministic and testable
   while being honest that the model itself is not. It also removes API cost and network flake from
   CI entirely. **[INFERENCE]** This is the technique I would build first.
3. **Seeded determinism.** Useful for everything *except* the model: the corpus sampling, any
   permutation testing in Getis-Ord Gi*, any tie-breaking. Signal Zero's statistical core is
   already zero-LLM, which means it should be **bit-for-bit reproducible** — and that is a testable
   property worth asserting explicitly rather than assuming.
4. **Statistical assertions over N runs.** Given arXiv 2407.10457, this is the methodologically
   correct way to assert on live model behaviour: run each golden case N times, assert on a *rate*
   with an explicit tolerance, and let the suite report the distribution. Materially more credible
   than a single pass/fail.
5. **Adversarial / red-team evals as a scored suite**, not a boolean. Per §1.4 and arXiv 2510.09023,
   report the attack success rate and the number of attempts per case — because defences that look
   perfect at one attempt degrade badly at ten.
6. **Mutation testing over the deterministic core** (§7) — the meta-test that proves the tests
   assert anything at all.

### 8.4 Flake management

**[PRIMARY]** Google Testing Blog, *Flaky Tests at Google and How We Mitigate Them* (John Micco,
27 May 2016) describes the mitigations: quarantining flaky tests off the critical path, reruns
applied *only* to tests already marked flaky or on explicit request, categorising tests by whether
flakiness is configuration-dependent, and monitoring. The post explicitly frames flakiness as a
testing problem that undermines the ability to detect real bugs.
<https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html>

**[PRIMARY]** *Where do our flaky tests come from?* (Jeff Listfield, 17 April 2017) analysed
approximately 4.2 million tests and found larger test binaries are more flaky, an approximately
linear relationship. <https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html>
**[INFERENCE]** That finding independently supports GitLab's 0.24% E2E share in §6 — bigger tests
are flakier, so keep the big ones few.

**[UNVERIFIED]** The widely-quoted Google figures "1.5% of test runs are flaky" and "16% of tests
have some flakiness" did not appear in the bodies of the three posts I fetched. Do not repeat them
as Google-sourced without finding the primary.

**[INFERENCE]** For Signal Zero the flake policy should be a written rule, because the project has
a *known* flake source: the tier-3 turn timeout that fires at 15,000ms and falls back. The credible
handling is (a) that path is deterministic-replay tested so it does not flake in CI, and (b) the
live-model eval reports it as a measured rate rather than failing the build. Blanket retries are
the wrong answer and Google's post says so — reruns only for tests already identified as flaky.

---

## 9. Coverage

### What is actually expected

**[PRIMARY]** Martin Fowler, *TestCoverage*: coverage is a diagnostic for finding untested code,
not a measure of testing adequacy. Rigid targets are counterproductive because teams optimise for
the metric and write meaningless tests. He suggests that with thoughtful testing, coverage in the
upper 80s or 90s is reasonable and below 50% signals trouble, while remaining suspicious of 100%.
His actual sufficiency test is behavioural, not numeric: you are testing enough if bugs rarely
escape to production **and** you are rarely afraid to change code.
<https://martinfowler.com/bliki/TestCoverage.html>

**[UNVERIFIED — flagged deliberately]** Google is widely reported to use 60% acceptable / 75%
commendable / 90% exemplary, from *Code Coverage Best Practices* (August 2020). My direct fetch of
that post returned only page chrome; the figures came from a search summary. If you cite these,
read the post first: <https://testing.googleblog.com/2020/08/code-coverage-best-practices.html>

### The credible critique

**[INFERENCE, but the mechanism is documented in the Radar entry in §7]** The critique is not "high
coverage is bad." It is that **line coverage measures execution, not assertion.** A test that
executes a function and asserts nothing scores identically to one that asserts everything. This has
become sharper with AI-generated tests, which are cheap to produce and easy to produce hollow —
exactly the concern the Thoughtworks mutation-testing entry names.

**[INFERENCE]** The strong move in an interview is therefore not to quote a coverage number. It is:
"Coverage tells me what I have *never executed*, so I use it as a gap-finder. For whether the tests
actually assert anything, I use mutation score." That answer demonstrates you understand what the
metric measures, and it converts §7's differentiator into a coherent position rather than a
tool you bolted on.

### For this repo specifically

**[PRIMARY]** `node:test` supports coverage natively — no new dependency needed.
<https://nodejs.org/api/test.html>
- `--experimental-test-coverage` — **stability 1, experimental.**
- `--test-coverage-include` / `--test-coverage-exclude`; `NODE_V8_COVERAGE`.
- Thresholds via the `run()` API: `lineCoverage`, `branchCoverage`, `functionCoverage`.
- Reporters include `lcov`, `junit`, `spec`, `tap`, `dot`.
- **`mock` is stable**: `mock.fn`, `mock.method`, `mock.module`, and `mock.timers` with
  `enable({apis:['setTimeout','Date']})` / `tick()` — directly useful for the time-between-events
  baseline in §8.3.
- **Snapshot testing is stable as of v23.4.0**: `t.assert.snapshot()`, `t.assert.fileSnapshot()`,
  `--test-update-snapshots`.

**[MEASURED]** `package.json` declares `"engines": {"node": ">=20"}` while the stack is documented
as Node 24. Snapshot support landed in v23.4.0 and `mock.module` is also recent — so **the declared
engine floor is below the version the features require.** Worth reconciling: either raise the
floor or avoid the newer APIs. Small, but it is the kind of inconsistency a careful reviewer finds.

**[INFERENCE]** Report branch coverage, not just line coverage, and report it *per subsystem* — the
deterministic statistical core should be held to a much higher bar than the Express glue, and
saying so demonstrates judgement that a single repo-wide percentage cannot.

---

# PART THREE — PRIORITISED FOR SIGNAL ZERO

Ordered by *credibility gained per unit of effort*, across both disciplines.
All gap claims below are **[MEASURED]**; all prioritisation is **[INFERENCE]**.

## Table stakes — their absence is actively read as a negative

These are not differentiators. They are the things whose absence causes a reviewer to discount
everything else, because 195 tests that no machine runs are a claim, not evidence.

| # | Item | Why it is table stakes | Effort |
|---|---|---|---|
| 1 | **CI running the 195 tests and the eval suite on every push** | Scorecard's CI-Tests check; the precondition for every other claim in this document being verifiable by a stranger. Currently `.github/workflows` does not exist. | Low |
| 2 | **`LICENSE`** | A public repo without one is not legally reusable. Instantly visible. | Trivial |
| 3 | **`SECURITY.md`** | Scorecard checks for it; it is where the §3.2 secret-scan evidence belongs. | Trivial |
| 4 | **Secret scanning in CI over full history** + a pre-commit hook | §3.1. Converts a clean history from a claim into a continuously-asserted fact. | Low |
| 5 | **Linter + formatter config** | Absent. Not a security control, but its absence undercuts the "industry-standard" positioning the project is going for. | Low |
| 6 | **Workflow least-privilege `permissions:`, SHA-pinned actions, Dependabot/Renovate** | Scorecard high-risk checks. Cheap once CI exists. | Low |
| 7 | **Coverage reported in CI** (`--experimental-test-coverage`, lcov) | §9. No new dependency. Report it; do not gate hard on a number. | Low |
| 8 | **Reconcile the `engines` floor with the Node APIs actually used** | §9. A five-minute fix that a careful reviewer would otherwise find. | Trivial |

## Differentiators — few portfolio projects have these, and this project is unusually well-suited

Ordered by how much distance each creates.

| # | Item | Discipline | Why it differentiates |
|---|---|---|---|
| 1 | **A written threat model**: DFD, trust boundaries, STRIDE per boundary, ML threats from ATLAS / OWASP agentic, plus a residual-risk table | Security | §4. Cloudflare's posting literally names STRIDE as a duty. Nearly no portfolio project has one. Highest signal available. |
| 2 | **Deterministic replay of recorded model responses** | QA | §8.3. Makes the whole pipeline testable in CI without the model, and demonstrates you understand *why* temperature 0 is not determinism (§8.1). |
| 3 | **Mutation testing (Stryker) over the deterministic core, with a published score** | QA | §7. Thoughtworks Radar Trial, April 2026. Directly pre-empts the obvious challenge to "195 tests." |
| 4 | **Adversarial evals reported as a rate over N attempts, not pass/fail** | Both | §1.4 + §8.3. arXiv 2510.09023 shows defences collapse under repeated attempts; measuring that is a genuinely sophisticated move. |
| 5 | **Attribution: hash-chained approval log + per-agent identity in the audit trail + a written authorization matrix** | Security | §5. Makes "a *named* human approves an irreversible action" true rather than aspirational. Addresses ASI03, ASI09 and Repudiation at once. |
| 6 | **Property-based tests on the statistical core** (fast-check over Fellegi–Sunter, the Exponential/Gamma baseline, Getis-Ord Gi*) | QA | §7. Real mathematical invariants, not contrived ones. Rare in portfolios. |
| 7 | **A supply-chain document**: what code and what *instructions* execute here, and where each comes from | Security | §2.2. The TrueForge + MCP + remote-provider chain is genuinely unusual. Addresses LLM04 and ASI04. More interesting than a generated SBOM. |
| 8 | **SBOM in CI (CycloneDX or SPDX) + `actions/attest-build-provenance`** | Security | §2. SLSA Build L2 by construction; document the `gh attestation verify` command. Do it *after* item 7. |
| 9 | **Fuzzing the Bright Data response parser** | Both | §7. Hostile-by-assumption input from the open web. Counts in both disciplines. |
| 10 | **A written flake policy** covering the known tier-3 timeout | QA | §8.4. Quarantine-and-measure, not blanket retry. Google's own guidance is explicit that reruns apply only to already-identified flaky tests. |

## Explicitly *not* worth doing — and be prepared to say why

**[INFERENCE]** Saying no with a reason is itself a signal. Doing these would read as
résumé-driven development:

- **Contract testing (Pact).** Single deployable, no independent consumers. §7.
- **Full OIDC login** — *unless* the app is deployed publicly, in which case it becomes table
  stakes rather than a differentiator. §5.
- **A vector-store security section.** There is no vector store. LLM09 does not apply and claiming
  it would be padding. §1.3.
- **Chasing a coverage percentage.** §9. Report it, use it as a gap-finder, and let the mutation
  score carry the argument about test quality.

## The one framing note

**[INFERENCE]** Per §6, GitLab has folded Software Engineer in Test into Backend Engineer. That,
plus Cloudflare's product-security posting asking for AI/LLM automation skill inside a classic
AppSec role, and Chainguard hiring into security from a software-engineering foundation while
naming agentic systems as in-scope — all three point the same way. The market is not asking for a
QA specialist or a security specialist. It is asking for an engineer who can demonstrate both
against a real system.

Signal Zero's genuine advantage is that its hardest security problem and its hardest testing
problem are the *same* problem: untrusted web content reaching a non-deterministic model whose
output influences a decision a human will act on. Items 1, 2 and 4 in the differentiator table all
attack that one problem from different sides. That is a much stronger story than a longer list of
unrelated tools.

---

## Full source list

**Standards, specs and official documentation**
- OWASP Top 10 for LLM Applications 2026 — <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10>
- OWASP LLM Top 10 2026 resource page — <https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/>
- OWASP LLM Top 10 2025 archive — <https://genai.owasp.org/llm-top-10/>
- OWASP Top 10 for Agentic Applications 2026 — <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>
- OWASP ASVS — <https://github.com/OWASP/ASVS>
- SLSA build levels — <https://slsa.dev/spec/v1.0/levels> (v1.0 retired; v1.2 active)
- GitHub artifact attestations — <https://docs.github.com/en/actions/concepts/security/artifact-attestations>
- GitHub remediating a leaked secret — <https://docs.github.com/en/code-security/secret-scanning/working-with-secret-scanning-and-push-protection/remediating-a-leaked-secret>
- OpenSSF Scorecard — <https://github.com/ossf/scorecard>
- CISA 2026 Minimum Elements for an SBOM — <https://www.cisa.gov/resources-tools/resources/2026-minimum-elements-software-bill-materials-sbom> *(PDF fetch blocked 403)*
- Microsoft Threat Modeling Tool — STRIDE — <https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats>
- Node.js `node:test` — <https://nodejs.org/api/test.html>
- Anthropic eval guidance — <https://platform.claude.com/docs/en/test-and-evaluate/eval-tool>

**Job postings and published career ladders**
- Cloudflare, Product Security Engineer — <https://job-boards.greenhouse.io/cloudflare/jobs/8102768>
- Chainguard, Security Engineer — <https://job-boards.greenhouse.io/chainguard/jobs/4700281006>
- GitLab Backend Engineer job family — <https://handbook.gitlab.com/job-families/engineering/backend-engineer/>
- GitLab Software Engineer in Test *(deprecated)* — <https://handbook.gitlab.com/job-description-library/engineering/software-engineer-in-test/>
- GitLab testing levels & measured distribution — <https://docs.gitlab.com/development/testing_guide/testing_levels/>
- Trail of Bits careers — <https://trailofbits.com/careers/> *(posting bodies not fetched)*
- Snyk careers — <https://snyk.io/careers/> *(posting bodies not fetched)*

**Research and engineering writing**
- *The Attacker Moves Second* — arXiv 2510.09023 — <https://arxiv.org/abs/2510.09023>
- *The Good, The Bad, and The Greedy* — arXiv 2407.10457 — <https://arxiv.org/abs/2407.10457>
- Thinking Machines, *Defeating Nondeterminism in LLM Inference* — <https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/>
- Simon Willison, *The lethal trifecta* — <https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/>
- Martin Fowler, *TestPyramid* — <https://martinfowler.com/bliki/TestPyramid.html>
- Martin Fowler, *TestCoverage* — <https://martinfowler.com/bliki/TestCoverage.html>
- Thoughtworks Technology Radar Vol. 34, April 2026 — <https://www.thoughtworks.com/radar/techniques> · <https://www.thoughtworks.com/radar/techniques/mutation-testing>
- Google Testing Blog, flaky tests — <https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html> · <https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html>
- Google Testing Blog, code coverage — <https://testing.googleblog.com/2020/08/code-coverage-best-practices.html> *(body not retrieved)*

**Secondary reporting**
- Help Net Security on the 2026 LLM Top 10 — <https://www.helpnetsecurity.com/2026/08/06/owasp-2026-llm-top-10-released/>
- The Decoder on Gray Swan prompt-injection figures — <https://the-decoder.com/claude-opus-4-5-resists-prompt-injections-better-than-rivals-but-still-falls-to-strong-attacks-alarmingly-often/>
- Auth0 on the OWASP agentic list — <https://auth0.com/blog/owasp-top-10-agentic-applications-lessons/> *(vendor-authored)*
- Promptfoo OWASP agentic docs — <https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/>
- GitGuardian on push-protection limits — <https://blog.gitguardian.com/github-push-protection-enhancing-open-source-security-with-limitations-to-consider/>
- RunSafe / OPSWAT on CISA 2026 SBOM elements — <https://runsafesecurity.com/blog/sbom-minimum-elements-cyclonedx-spdx/> · <https://www.opswat.com/blog/cisas-2026-sbom-minimum-elements-now-require-post-build-data>
