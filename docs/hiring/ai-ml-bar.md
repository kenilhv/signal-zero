# The 2026 AI / ML / Agentic-AI hiring bar — evidence, and what Signal Zero must do about it

**Compiled:** 30 August 2026.
**Method:** primary sources only where possible — live job-board APIs pulled directly, engineering
blogs and specifications fetched directly, one GitHub API + raw-file check to verify a standards claim.

---

## 0. Method, and an honesty ledger

### 0.1 What I actually pulled

I fetched public job-board APIs directly rather than reading recruiter summaries. Each returns the
full posting body as published by the company:

| Company | Endpoint | Postings returned |
|---|---|---|
| OpenAI | `api.ashbyhq.com/posting-api/job-board/openai` | 754 |
| Anthropic | `boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true` | 571 |
| Databricks | `boards-api.greenhouse.io/v1/boards/databricks/jobs?content=true` | 856 |
| Sierra | `api.ashbyhq.com/posting-api/job-board/Sierra` | 200 |
| LangChain | `api.ashbyhq.com/posting-api/job-board/langchain` | 107 |
| Cognition | `api.ashbyhq.com/posting-api/job-board/cognition` | 89 |
| Baseten | `api.ashbyhq.com/posting-api/job-board/baseten` | 81 |
| Modal | `api.ashbyhq.com/posting-api/job-board/modal` | 31 |
| Anyscale | `api.ashbyhq.com/posting-api/job-board/anyscale` | 20 |
| Scale AI | `boards-api.greenhouse.io/v1/boards/scaleai/jobs?content=true` | fetched |

Individual postings quoted below were also verified against their public `jobs.ashbyhq.com` /
`job-boards.greenhouse.io` URLs, which are cited inline.

### 0.2 What I could not verify — stated plainly

- **Harvey** renders its careers pages client-side; direct fetches returned only the shell. The one
  Harvey posting I quote comes from a **BuiltIn mirror**, and that mirror states the posting was
  **removed on 31 Jan 2026**. Treat it as a dated artefact, not a live requirement.
- **TrueFoundry**: their careers pages and the CareerPuck board are JS-rendered; I could not fetch a
  full posting body. I have only a search-engine summary, which I do **not** treat as a primary quote.
- **Meta** and **Google DeepMind**: `metacareers.com` and Google Careers are JS-rendered. I fetched
  exactly one DeepMind posting via its Greenhouse mirror (cited). Everything else about Meta/DeepMind
  here is search-engine summary and is labelled as such.
- **Salary bands**: I quote only bands that appeared in a posting body I actually fetched. I have
  invented none, and I am not reporting any market-wide compensation statistics.
- **"How common is X across the whole market"**: I can only speak to the ~2,700 postings I pulled
  from ten boards. That is not the market. It is a large, current, frontier-weighted sample.

### 0.3 About the keyword counts in this document

I ran regex counts over the fetched posting bodies. Two honest caveats, because the raw numbers are
misleading without them:

1. **Boilerplate contamination.** LangChain's shared "ABOUT US" block names *"LangSmith (Observability,
   Evaluation, Deployment, Fleet, and Sandboxes)"*, which made "eval", "observability" and "sandbox"
   hit **100%** of LangChain postings on a naive count. Every number below is from a **second pass**
   that cuts each posting at its first `ABOUT THE ROLE` / `ABOUT THE TEAM` / `ROLE:` / `WHAT YOU`
   marker and counts only the role body. The LangChain numbers dropped from 100% to 81% / 66% / 9%
   once trimmed — the trimmed numbers are the ones I use.
2. **Title-based family filter.** "Engineering postings" = title matches
   `engineer|scientist|technical staff|research` and does not match
   `sales|account|recruit|marketing|counsel|people|finance|IT support|program manager|product manager|designer`.
   Sales-engineering roles survive this filter, which inflates customer-facing counts slightly.

These are *my* measurements over *my* sample. They are labelled as such throughout and are not
presented as anyone's published study.

---

## 1. The four role families, and what postings literally ask for

The four families genuinely do have different bars. Here is the evidence, family by family.

### 1.1 AI / Agent Engineer (LLM applications, tool-calling, orchestration)

**What is literally asked for.** The single most repeated demand is *shipping* + *measurement*, not
model knowledge.

Sierra, **Software Engineer, Agent Architecture** (SF) —
[posting](https://jobs.ashbyhq.com/Sierra/b3829801-8e0b-4047-8cd8-8a51c87028fd). Responsibilities
include *"Design the agentic loop"*, and the posting asks: *"What primitives do we need to build
agents that are steerable and verifiable, while still conversational and adaptive?"* A named
responsibility is *"Build evaluation systems"* — *"You'll design frameworks that allow us and our
customers to measure and improve agent quality over time."* The hard requirement is *"4+ years
hands-on experience building production products and systems"*; retrieval/eval/LLM experience sits
under **"EVEN BETTER"**, i.e. it is a *preference*, not a gate.

Sierra, **Software Engineer, Agent** (London) —
[posting](https://jobs.ashbyhq.com/Sierra/b7d1dbcd-ca72-472f-b15e-5b4b0f886be0). Requirements are
*"Experience building and scaling end-to-end production systems"* and *"Strong technical
problem-solving skills, especially in fast-changing, ambiguous environments"*. Under "EVEN BETTER":
*"Familiarity with tools that power today's AI agents: eval frameworks, agent tooling, RAG pipelines,
and prompt engineering."*

LangChain, **Fullstack Software Engineer, Applied AI** (SF) —
[posting](https://jobs.ashbyhq.com/langchain/c75915ba-a32b-4e17-873d-19b47564170d). Required:
*"Experienced software engineer with a strong track record shipping AI or ML-powered applications
(typically 3+ years, including at least 1 year building LLM systems in production)"* and — as a
required bullet, not a nice-to-have — *"Hands-on experience implementing evaluation and monitoring
systems for agents or workflows."* Also required: *"Deep understanding of the components that make up
an AI system: prompting, retrieval, orchestration, inference APIs, and model selection across
modalities."*

Machinify, **AI Engineer | Agentic Systems** —
[posting](https://job-boards.greenhouse.io/machinifyinc/jobs/4146862009). This is the most explicit
posting I found on eval-first practice: *"Build evals before you build the agent. Diagnose where it
fails, fix the root cause"*, and a requirement literally phrased *"A bias toward measurement: you
don't ship without an eval."* Also required: *"Deep, hands-on understanding of agent loops — how a
model decides to call a tool"*, and *"Hands-on experience with at least one major agent SDK — OpenAI
Agents SDK, Anthropic SDK / claude-agent-sdk, LangGraph"*. Strongly preferred: *"Experience designing
structured outputs (Pydantic / JSON Schema) and tool interfaces that LLMs reliably call correctly."*

Baseten, **AI Engineer** —
[posting](https://jobs.ashbyhq.com/baseten/b13ec426-d09d-4122-8112-cf25adbd7d60). Responsibilities:
*"Design the harnesses, execution flows, and guardrails that make AI systems reliable in production"*
and *"Define and instrument evals so you know whether a change actually improved output quality."*
Note the framing of the whole role — *"you'll pick the problems worth solving, build the harnesses…
and own the results."*

OpenAI, **Backend Software Engineer (Evals)** —
[posting](https://jobs.ashbyhq.com/openai/3d064454-c0c3-4225-bc2c-6d8c0f8735b2). This is an
*application-side* eval-infrastructure role, and it is the clearest statement of what "credible eval
suite" means as a job: *"Design eval pipelines that are reliable, reproducible, and extendable"* and
*"Build the infrastructure for continuous eval monitoring frameworks (regression/drift monitoring,
building robust golden datasets) along with feedback loops."* Requirements include *"4+ years of
backend engineering experience"*, *"Experience creating production evals and/or measuring performance
of ML/LLM models at scale"*, and familiarity with *"patterns like multi-agent workflows, tool use, or
long context."*

Anthropic, **Forward Deployed Engineer** —
[posting](https://job-boards.greenhouse.io/anthropic/jobs/5391016008). Required: *"8+ years of
experience in a technical, customer facing role"* and *"Production experience with LLMs including
advanced prompt engineering, agent development, evaluation frameworks, and deployment at scale."*
Deliverables are named concretely: *"Deliver technical artifacts for customers like MCP servers,
sub-agents, and agent skills that will be used in production workflows."*

**Family summary (my inference, labelled as inference).** The AI/Agent Engineer bar is a *software
engineering* bar with an evaluation discipline bolted on top. Nobody asks for model training. Almost
everybody asks for: production systems experience (3–5 years typical, 8+ for FDE/staff), agent-loop
and tool-calling fluency, and demonstrable eval design. Frontier labs and agent companies converge on
this; the differentiator between candidates is whether you can show *measurement*, not whether you can
show *a working demo*.

### 1.2 ML Engineer (training, serving, feature pipelines)

This family is the one whose classic shape is being squeezed, and I want to be careful not to
overstate that — I did not find a study proving it. What I *can* report is what the postings say.

Databricks, **Staff Machine Learning Engineer** —
[posting](https://databricks.com/company/careers/open-positions/job?gh_jid=8401114002). This is the
most recognisably "classic ML engineer" posting in my sample, and it still leads with GenAI:
*"Design and implement ML pipelines for data preprocessing, feature engineering, model training,
hyperparameter tuning, and model evaluation, enabling rapid experimentation and iteration"*, plus
*"Build scalable, reusable backend systems to support GenAI products across the company. Develop
robust logging, telemetry, and evaluation harnesses to ensure reliable model performance."*
Requirements: *"2-8 years of machine learning engineering experience"*, *"Proficiency in Python,
TensorFlow/PyTorch, and scalable ML architectures"*, *"Ability to drive end-to-end model development,
from research and prototyping to deployment and monitoring"*, and — notably — *"Experience with LLM
fine-tuning, prompt engineering, and retrieval-augmented generation (RAG) is a bonus"*, i.e. a bonus,
not a gate.

Databricks, **Senior Staff Applied AI Engineer – Context Retrieval** —
[posting](https://databricks.com/company/careers/open-positions/job?gh_jid=8540267002). Worth reading
in full if you are positioning a retrieval/ranking project. It asks you to *"Build the full retrieval
stack from scratch. Own the end-to-end system: query understanding, content understanding and
indexing, hybrid retrieval, ranking, and evaluation"*, and to *"Build the evaluation flywheel for both
retrieval and subagents."* It also names the hard part explicitly: subagents that decide
*"whether the retrieved content is actually sufficient to answer the question."*

Anyscale, **Distributed LLM Inference Engineer** —
[posting](https://jobs.ashbyhq.com/anyscale/1cf38233-8aa0-47f8-9d85-65ce27bc3047). Requirements are
systems-shaped: *"Familiarity with running ML inference at large scale with high throughput and low
latency"*, *"Solid understanding of distributed systems, ML inference challenges"*, with vLLM /
TensorRT-LLM / CUDA under bonus points.

Google DeepMind, **Research Engineer, Human Understanding** —
[Greenhouse posting](https://job-boards.greenhouse.io/deepmind/jobs/7669433). Required: PhD +3 years,
*"Strong programming skills in Python"*, experience with JAX, and experience *"working with and tuning
large-scale vision language models"*. This is a hard credential gate and is worth naming as such.

**Family summary (inference).** For an applied job-seeker, the honest read is: the classic
"train/serve/feature-pipeline" ML Engineer role at a frontier-adjacent company now either (a) folds
into GenAI product work, where the evaluation and retrieval story dominates, or (b) folds into
inference-platform work, where CUDA/vLLM/distributed-systems depth dominates. A portfolio project
without a trained model can credibly target (a). It cannot credibly target (b) or a DeepMind-style
research role.

### 1.3 Research Engineer / Applied Scientist (RL, evaluation methodology)

Anthropic, **Research Engineer, Model Evaluations** —
[posting](https://job-boards.greenhouse.io/anthropic/jobs/5198255008). Responsibilities include
*"Design and run new evaluations of Claude's capabilities — reasoning, agentic behavior, knowledge,
safety properties"*; *"Build and harden the distributed eval execution platform so hundreds of evals
run reliably"*; *"Debug anomalous eval results mid-training-run, determine whether the cause is a
model change or an infrastructure issue"*; and *"Run experiments to characterize how prompting,
sampling, and scaffolding choices affect results."* Preferred qualifications explicitly include
*"Experience developing robust evaluation metrics for language models"* and **"Background in
statistics and experimental design"**. Minimum qualifications are engineering, not research:
*"Strong Python programming skills"*, *"Experience building or operating distributed systems, data
pipelines, or other infrastructure"*, and *"Comfort operating in an on-call or production-support
capacity when training runs are live"*.

OpenAI, **Research Engineer, Frontier Evals & Environments** —
[posting](https://jobs.ashbyhq.com/openai/bba18df5-f30f-4d2c-909c-30e651f95579). *"Create ambitious RL
environments to push our models to their limits"*; *"Dive deep into the science of measurement,
including understanding scalability, reliability, and variance of our evaluation methodology"*;
*"Design scalable systems and processes to support continuous evaluation."* The posting names its own
prior art — GDPval, SWE-bench Verified, MLE-bench, PaperBench, SWE-Lancer. Candidate profile:
*"strong technical fundamentals in machine learning, software engineering, systems, statistics"* plus
*"hands-on experience with LLMs, RL, RLHF/RLAIF, post-training, evals, graders, synthetic data…"*

Anthropic, **Research Engineer, Code RL (Reinforcement Learning)** —
[posting](https://job-boards.greenhouse.io/anthropic/jobs/5254364008). Baseline is software
engineering — *"Strong software-engineering skills and deep Python expertise, including
async/concurrent programming"*. RL sits under **"Strong candidates may also have"**: *"Experience with
reinforcement learning, RLHF, post-training, or LLM finetuning"*, alongside *"Built coding agents,
code-execution sandboxes, eval harnesses, verifiers, or developer tooling"*. The posting body I
fetched lists a compensation range of **$500,000 – $850,000 USD**.

Cognition, **Research Engineer, Post-Training** —
[posting](https://jobs.ashbyhq.com/cognition/72d3db28-07d3-4c28-b49f-1bdf6e8e0f10). Two lines here are
the sharpest statement of eval seriousness I found anywhere: *"Build evals that actually capture what
matters. The loop never ends: define, optimize, realize the gaps, and rebuild. You'll be responsible
for making numbers go up and making sure the numbers mean something."* And on statistics: candidates
need *"Strong fundamentals in probability, statistics, and ML theory. The ability to look at
experimental data and distinguish real effects from noise and bugs."* Also: *"We care more about
demonstrated capability than credentials. A PhD is one signal among many."*

Scale AI, **Machine Learning Research Scientist, Evaluations** —
[posting](https://job-boards.greenhouse.io/scaleai/jobs/4728014005). *"Analyze model behavior to
identify, characterize, and diagnose failure modes in frontier LLMs"*; *"Design and build benchmarks
and evaluation methods"*; *"Apply post-training expertise (SFT, RLHF, reward modeling) to connect
observed failures to the data and training interventions."* Requires *"Ph.D. or Master's"* and
publication at NeurIPS/ICML/ICLR-tier venues.

**Family summary (inference).** Note the split. *Eval-platform* research-engineer roles (Anthropic
Model Evaluations) have engineering minimums and statistics as a *preferred*. *Post-training / RL*
research roles have real credential and publication gates (Scale AI, DeepMind) or demand a track
record of training work (Cognition). A portfolio project can plausibly reach the first. It cannot
reach the second, and pretending otherwise will be detected in ten minutes of interview.

### 1.4 AI Infrastructure / Inference Platform Engineer

Modal, **Member of Technical Staff – ML Performance** —
[posting](https://jobs.ashbyhq.com/modal/af17da5e-23ca-4802-854d-5f0546e1ed32). Requirements, in full:
*"5+ years of experience writing high-quality, high-performance code"*; *"Experience working with
torch, high-level ML frameworks, and inference engines (vLLM or TensorRT)"*; *"Familiarity with Nvidia
GPU architecture and CUDA"*; and, most tellingly, *"Experience with ML performance engineering (tell
us a story about boosting GPU performance — debugging SM occupancy issues, rewriting an algorithm to
be compute-bound, eliminating host overhead, etc)"*.

Modal, **Member of Technical Staff – Research, Inference** —
[posting](https://jobs.ashbyhq.com/modal/73c97bbc-8e27-4c5d-b38b-90b3afdb0d93). Scope: *"speculative
decoding, disaggregated prefill/decode, quantization (FP8, INT4), KV-cache and memory management,
autoscaling for spiky serverless traffic"*, and a metric-first framing: *"acceptance length is the
metric that decides the win."*

Baseten, **Software Engineer – Baseten Inference Stack** —
[posting](https://jobs.ashbyhq.com/baseten/c8701794-bdc1-4932-bffa-a444ce57ed73). *"Build platform
capabilities related to routing, autoscaling, scheduling, observability, and runtime management"*;
*"Help define best practices around testing, release automation, benchmarking, and operational
excellence"*; *"Debug complex production systems spanning Kubernetes, distributed runtimes,
networking, and GPU workloads."*

Anthropic, **Performance Engineer, Inference Systems** —
[posting](https://job-boards.greenhouse.io/anthropic/jobs/5224564008). The team holds the fleet to a
bar across *"throughput, latency, reliability, and correctness"*, and the posting says the quiet part
out loud: *"We're looking for performance engineers who treat correctness as part of performance."*
A named responsibility is to *"Own and improve the correctness evaluation pipeline that validates
model output quality across hardware platforms, numerics, and serving configurations."* Minimum
qualifications include *"profiling, roofline analysis, latency/throughput optimization"* and
*"Solid data analysis skills (e.g. SQL, pandas, or similar) sufficient to turn raw telemetry into
clear findings."*

Anthropic, **Staff Software Engineer, AI Reliability** —
[posting](https://job-boards.greenhouse.io/anthropic/jobs/5113224008). *"Develop appropriate Service
Level Objectives for large language model serving systems, balancing availability and latency with
development velocity"*; *"Design and implement monitoring and observability systems across the token
path"*; *"Lead incident response for critical AI services, ensuring rapid recovery, thorough incident
reviews, and systematic improvements."*

Anthropic, **Tech Lead Manager, Agent Runtime Platform** —
[posting](https://job-boards.greenhouse.io/anthropic/jobs/5316593008). Relevant because it names
agent-sandboxing as an infrastructure discipline: *"Define what secure agent execution means at
scale, partnering with security teams on sandboxing, isolation, and credential management."*
Preferred: *"Experience with harness engineering"*.

OpenAI, **Security Engineer, Agent Security** —
[posting](https://jobs.ashbyhq.com/openai/e9bea775-7eb6-438a-ab96-27d5f941e69d). *"Architecting
security controls for agentic AI – design, implement, and iterate on identity, network, and
runtime-level defenses (e.g., sandboxing, policy enforcement)"*, requiring *"Deep expertise in modern
isolation techniques – experience with container security, kernel-level hardening, and other isolation
methods."*

**Family summary (inference).** This family's bar is kernels, schedulers, Kubernetes, and GPU
performance stories. A Node/Express project with no GPU work does not clear it and should not try.
The *one* legitimate bridge from Signal Zero into this family is the SLO / correctness-as-performance
framing that both the Anthropic AIRE and Inference Systems postings use — see §7.

---

## 2. Q1 — EVALUATION: how much it is emphasised, and what a serious suite looks like

### 2.1 How much it is emphasised — measured

My regex counts over role-body text (methodology and caveats in §0.3):

| Board | Eng. postings (n) | mention "eval*" | "observability" | "guardrail" | "sandbox" |
|---|---|---|---|---|---|
| LangChain | 47 | **81%** | 66% | 43% | 9% |
| Sierra | 52 | **60%** | 13% | 0% | 2% |
| Anthropic | 202 | 35% | 18% | 3% | 9% |
| OpenAI | 370 | 27% | 30% | 5% | 4% |
| Baseten | 35 | 20% | 49% | 6% | 6% |
| Cognition | 33 | 9% | 9% | 0% | 12% |
| Modal | 21 | 5% | 10% | 0% | 33% |

Read this correctly. LangChain and Sierra are agent companies where nearly every engineer touches
evaluation. Modal is an infrastructure company where almost nobody does, but a third of postings
mention sandboxes — because sandboxing *is* their product. **Eval emphasis is a function of role
family, not of the industry as a whole.** For the AI/Agent Engineer family specifically, evaluation is
close to a universal requirement.

Corroborating industry survey — **LangChain's *State of Agent Engineering* report**
([langchain.com/state-of-agent-engineering](https://www.langchain.com/state-of-agent-engineering)),
n = **1,340** respondents, fielded **18 Nov – 2 Dec 2025**:

- **57.3%** have agents in production; **30.4%** are actively developing with concrete deployment plans.
- **89%** have implemented observability; **62%** have detailed tracing. Among production users: 94%
  observability, 71.5% full tracing.
- **52.4%** run offline evaluations; **37.3%** run online evaluations; **47.6%** run **no** evaluations
  at all. Among production users, 77.2% run some evals.
- Evaluation approaches: **human review 59.8%**, **LLM-as-judge 53.3%**.
- Top barrier to production: **quality, 33%** (latency 20%). For orgs with 2,000+ employees, **security
  rises to the 2nd-largest barrier at 24.9%**.

This is a vendor-run survey of a vendor's own audience — a real, dated, methodologically-disclosed
survey, but self-selected toward LangChain users. I report it as such. Its most useful signal is the
**gap**: observability adoption (89%) runs far ahead of evaluation adoption (~52%). That gap is the
opening a portfolio project can exploit.

### 2.2 What a credible eval suite looks like in 2026

Sources here are (b)-type — *engineering blogs arguing for good practice* — plus one (a)-type primary
posting and one arXiv paper. Labelled accordingly.

**Structure (argued, not required).** Hamel Husain, *Your AI Product Needs Evals*
([hamel.dev/blog/posts/evals/](https://hamel.dev/blog/posts/evals/)) argues a three-level hierarchy:
Level 1 unit tests / assertions run on every change; Level 2 human + model evaluation over logged
traces; Level 3 A/B testing in production. He argues *"You can never stop looking at data—no free
lunch exists"* and recommends building domain-specific trace-viewing tools to *"remove all friction
from the process of looking at data."*

**LLM-as-judge, and its named pitfalls.** Husain's *Using LLM-as-a-Judge For Evaluation*
([hamel.dev/blog/posts/llm-judge/](https://hamel.dev/blog/posts/llm-judge/)) names the failure modes
directly: arbitrary uncalibrated multi-point scales (1–5 across many dimensions), metric sprawl, weak
critiques, skipping domain experts, and off-the-shelf judges — which he says *"tend to cause more
confusion than value."* His prescriptions: start with **binary pass/fail plus a written critique**;
build the judge iteratively against a named principal domain expert's labels; and on agreement
measurement, *"Using raw agreement is generally not recommended and can be misleading when classes are
imbalanced"* — report **precision and recall separately** instead.

The academic grounding for judge bias is Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and
Chatbot Arena* ([arXiv:2306.05685](https://arxiv.org/abs/2306.05685)), which identifies **position
bias**, **verbosity bias**, and **self-enhancement bias** (reporting GPT-4 favouring its own outputs by
~+10% and Claude by ~+25%), alongside limited reasoning ability — while also finding strong judges
reach **>80% agreement** with human preferences, roughly the human–human agreement level. Both facts
are true simultaneously; a serious eval suite quotes both.

**Statistical significance on small eval sets.** This is a real, citable body of work, not a vibe.
Evan Miller, *Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations*
([arXiv:2411.00640](https://arxiv.org/abs/2411.00640), submitted 1 Nov 2024) argues *"evaluations are
experiments"* and prescribes: report **CLT-based standard errors** alongside mean scores; use
**clustered standard errors** when questions are clustered (which breaks the CLT independence
assumption); analyse **paired differences** between models rather than independent comparisons; run
**power analysis** to size the question set; and **resample multiple answers per question** to reduce
scoring variance. For a small golden set this is exactly the toolkit — paired differences and error
bars are what make an n=50 eval defensible instead of embarrassing.

**Regression gates in CI.** This is real, tooled practice. Promptfoo (MIT-licensed CLI) is designed to
run `promptfoo eval` in CI and fail the build below a threshold; Braintrust ships a native GitHub
Action (`braintrustdata/eval-action`) that runs evals per pull request, posts a score summary as a PR
comment, and blocks merge below thresholds; Langfuse publishes an LLM-regression-testing guide
([langfuse.com/resources/engineering/llm-regression-testing](https://langfuse.com/resources/engineering/llm-regression-testing)).
On the employer side, OpenAI's Backend Software Engineer (Evals) posting asks literally for
*"continuous eval monitoring frameworks (regression/drift monitoring, building robust golden
datasets)"* — so "evals gate CI" is a requirement in a real job, not just a vendor pitch.

**Evaluating the tools, not just the model.** Anthropic, *Writing effective tools for agents*
(11 Sep 2025, [anthropic.com/engineering/writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents))
argues for evaluation-driven tool development: generate many evaluation tasks *"grounded in real world
uses"*, keep **held-out test sets** to avoid overfitting, run evaluation **programmatically**, and
collect metrics beyond accuracy — *"total runtime"*, tool-call counts, token consumption. It also
observes that *"what agents omit…can often be more important than what they include."*

### 2.3 What separates a serious eval from a toy one

Synthesising the above — **this section is my inference**, drawn from the cited sources:

| Toy eval | Serious eval |
|---|---|
| One number, no interval | Point estimate **with** a standard error, and paired differences between variants |
| 1–5 Likert judge on "quality" | Binary pass/fail per named failure mode, plus a written critique |
| Judge never validated | Judge scored against human labels; **precision and recall reported separately** |
| Golden set written once by the author | Golden set grown from **observed production failures**, with a held-out split |
| Run manually before a demo | Run in CI on every PR, with a threshold that **fails the build** |
| Measures only final answer accuracy | Also measures tool-call correctness, runtime, token cost, and *omissions* |
| No failure taxonomy | Error analysis: failures categorised, each category has a test |
| Never re-validated | Judge and set re-validated when the model or system changes |

The single sharpest one-line articulation in any source I read is Cognition's: *"You'll be responsible
for making numbers go up and making sure the numbers mean something."*

---

## 3. Q2 — AGENT RELIABILITY: current state of practice

### 3.1 The OWASP entry, cited accurately

The current published edition is the **OWASP Top 10 for Large Language Model Applications 2025**,
whose entries are versioned `LLMxx:2025` ([genai.owasp.org/llm-top-10/](https://genai.owasp.org/llm-top-10/)).
The full list, verbatim:

- **LLM01:2025 Prompt Injection**
- **LLM02:2025 Sensitive Information Disclosure**
- **LLM03:2025 Supply Chain**
- **LLM04:2025 Data and Model Poisoning**
- **LLM05:2025 Improper Output Handling**
- **LLM06:2025 Excessive Agency**
- **LLM07:2025 System Prompt Leakage**
- **LLM08:2025 Vector and Embedding Weaknesses**
- **LLM09:2025 Misinformation**
- **LLM10:2025 Unbounded Consumption**

Cite it as *"OWASP Top 10 for LLM Applications 2025, LLM01:2025 Prompt Injection"* — not as "OWASP LLM
Top 10 2021" and not as "the OWASP Top 10". It is a distinct list from the web-application Top 10.
Prompt injection holds the #1 slot for the second consecutive edition. **Caveat:** I verified the 2025
edition is what the OWASP GenAI site publishes at that URL as of 30 Aug 2026; I did not find a later
edition, but I cannot prove none exists.

For an agentic system, the second entry that matters most is **LLM06:2025 Excessive Agency**
([genai.owasp.org/llmrisk/llm062025-excessive-agency/](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)),
defined around *"the ability to call functions or interface with other systems via extensions…to
undertake actions in response to a prompt"*, with root causes named as **excessive functionality,
excessive permissions, or excessive autonomy**. Its named mitigations are: minimize extensions;
minimize extension functionality; avoid open-ended extensions; minimize extension permissions; execute
extensions in the user's context; **require user approval** (human-in-the-loop for high-impact
actions); complete mediation (enforce authorization downstream); and sanitise LLM inputs and outputs.
OWASP additionally notes logging, monitoring and rate-limiting **limit damage without preventing the
vulnerability**.

### 3.2 Prompt injection: the honest state of the art

Simon Willison's **"lethal trifecta"**
([simonwillison.net/2025/Jun/16/the-lethal-trifecta/](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/))
names the three ingredients whose combination is dangerous: **access to your private data**,
**exposure to untrusted content**, and **the ability to externally communicate** *"in a way that could
be used to steal your data"*. He is explicit that the problem is unsolved — *"we still don't know how
to 100% reliably prevent this from happening"* — and skeptical of vendor guardrail products, arguing
that even a filter catching 95% of attacks is inadequate. His conclusion for end users assembling
their own tools: *"the only way to stay safe there is to avoid that lethal trifecta combination
entirely."*

**This is the single most important framing for a portfolio project.** A project that claims to have
"solved prompt injection" is disqualifying. A project that documents which corner of the trifecta it
has architecturally removed is credible.

Academic design-pattern work exists — Beurer-Kellner et al., *Design Patterns for Securing LLM Agents
against Prompt Injections*, arXiv:2506.08837 (June 2025). **I did not fetch this paper directly**; I
saw it referenced in search results, so I cite it as a pointer, not as a verified quote.

### 3.3 Guardrails: layered, not singular

OpenAI's *A Practical Guide to Building Agents*
([PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf))
argues guardrails are a **layered defense** — a single guardrail is rarely sufficient; multiple
specialised guardrails combined produce more resilient agents. It advocates combining **LLM-based
guardrails, rules-based guardrails such as regex, and a moderation API**. It also prescribes a
**per-tool risk rating** (low/medium/high) based on read-only vs write access, reversibility, required
account permissions, and financial impact, and using those ratings to trigger a pause for guardrail
checks or escalation to a human before high-risk functions execute.

### 3.4 Human-in-the-loop and sandboxing: the normative sources

**MCP specification, Tools** (revision 2025-11-25,
[modelcontextprotocol.io/specification/2025-11-25/server/tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools))
states, in RFC-2119 language:

> *"For trust & safety and security, there **SHOULD** always be a human in the loop with the ability to
> deny tool invocations."*

and requires applications to *"Present confirmation prompts to the user for operations, to ensure a
human is in the loop."* Clients **SHOULD**: *"Prompt for user confirmation on sensitive operations"*,
*"Show tool inputs to the user before calling the server, to avoid malicious or accidental data
exfiltration"*, *"Validate tool results before passing to LLM"*, *"Implement timeouts for tool calls"*,
and *"Log tool usage for audit purposes"*. Servers **MUST** validate all tool inputs, implement access
controls, rate-limit invocations, and sanitize outputs. There is also an explicit untrusted-metadata
rule: *"clients **MUST** consider tool annotations to be untrusted unless they come from trusted
servers."*

**MCP Security Best Practices** (same revision,
[modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices))
covers confused-deputy attacks against MCP proxies, the **token passthrough anti-pattern** (*"MCP
servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server"*), SSRF via
OAuth metadata discovery, session hijacking, local-server compromise, and **scope minimization** —
begin with a minimal scope set and elevate incrementally, rather than requesting an omnibus scope.

**Anthropic, *Building Effective Agents***
([anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents))
adds the agent-computer-interface argument: *"one rule of thumb is to think about how much effort goes
into human-computer interfaces (HCI), and plan to invest just as much effort in creating good
agent-computer interfaces (ACI)"*; recommends poka-yoke tool design — *"change the arguments so that
it is harder to make mistakes"*; and for autonomous agents recommends *"extensive testing in sandboxed
environments, along with the appropriate guardrails."* It also argues agents *"can pause for human
feedback at checkpoints or when encountering blockers"*, and warns that *"agentic systems often trade
latency and cost for better task performance."*

**Anthropic, *Writing effective tools for agents***, on retry/error behaviour: error responses should
avoid *"opaque error codes or tracebacks"* and instead provide *"specific and actionable
improvements"* — the design intent being that the agent can self-correct. The MCP spec encodes the same
split structurally: **protocol errors** (JSON-RPC) for malformed requests the model cannot fix, versus
**tool execution errors** (`isError: true`) which *"contain actionable feedback that language models
can use to self-correct and retry with adjusted parameters."*

### 3.5 What "reliable tool calling" means as a hiring requirement

The postings state it plainly. Machinify wants *"tool interfaces that LLMs reliably call correctly"*
and structured outputs via Pydantic/JSON Schema. LangChain's Deployed Engineer role requires having
*"designed agent-based or LLM-powered applications beyond simple API calls, including multi-step
workflows, orchestration, and **failure handling**"*. Baseten's AI Engineer role requires designing
*"the harnesses, execution flows, and guardrails that make AI systems reliable in production."*
Anthropic's Agent Runtime Platform TLM role names *"sandboxing, isolation, and credential
management"* as the definition of secure agent execution at scale.

**My inference:** the credible 2026 reliability story for an application-layer agent is:
typed tool schemas with validated outputs → deterministic (non-prompt) guardrails at the boundary →
per-tool risk classification with human approval on the high-risk ones → structured, actionable tool
errors that permit bounded retry → timeouts and rate limits → an audit log of every tool invocation →
adversarial tests in CI. Not "we added a system prompt telling it to be careful."

---

## 4. Q3 — RL / POST-TRAINING: is it actually asked for in application roles?

**Short answer: essentially no, and the data is unambiguous.**

### 4.1 The measurement

I searched every engineering posting body in my sample for
`RLHF | RLAIF | DPO | GRPO | preference optimization | post-training`. Here is **every matching
posting**, by title:

| Board | Matches | Titles that matched |
|---|---|---|
| Anthropic (202 eng.) | 9 | Research Engineer Code RL; Research Engineer ML (RL Velocity) ×2; Research Engineer Production Model Post-Training ×2; Research Engineer RL Engineering; Research Scientist Life Sciences; Staff+ Research Engineer RL Data Platform; Staff+ SWE RL Data Platform |
| Cognition (33 eng.) | 2 | Research Engineer Post-Training; Research Engineer Mid-Training |
| Modal (21 eng.) | 3 | MTS Research Post-Training; Forward Deployed Engineer – ML ×2 |
| Baseten (35 eng.) | 5 | Post-Training Research Scientist; Post-Training Research Engineer; SWE Training Product; FDE (Training); **AI Engineer** |
| LangChain (47 eng.) | 4 | **Research Engineer LangSmith Engine**; Deployed Engineer Professional Services ×3 |
| Sierra (52 eng.) | **0** | — |
| OpenAI (370 eng.) | 26 | Almost entirely `Research*` / `Agent Post-Training *` / `Researcher, *` titles |

Direct term counts, same sample: **DPO appears in 3 postings total** (all LangChain), **GRPO in 0**,
**PPO in 0**. `RLHF` appears in 3% of Anthropic engineering postings and 3% of OpenAI's.

**Sierra — an agent company with 52 engineering postings — mentions none of these terms even once.**

### 4.2 Where it *does* appear, and in what grammatical position

Even in research roles it is frequently listed as a *preference*, not a requirement. Anthropic's Code
RL posting puts *"Experience with reinforcement learning, RLHF, post-training, or LLM finetuning"*
under **"Strong candidates may also have"** — the *minimum* is Python and software engineering.
LangChain's Research Engineer, LangSmith Engine posting puts *"Hands on experience with reinforcement
learning, preference optimization, SFT, RLHF/RLAIF, or other post-training techniques for LLMs"* under
**"NICE TO HAVE"**, while its **required** bullets are *"Strong experience designing benchmarks,
evaluations, and experiments for AI/ML systems; you know how to tell whether a change actually made an
agent better."*

Where it is a genuine gate: Scale AI's Evaluations Research Scientist (PhD/Master's + NeurIPS-tier
publications + *"post-training techniques such as RLHF, preference modeling, or instruction tuning"*)
and Cognition's Post-Training role (*"A track record of advancing ML systems through post-training,
alignment, or related methods"* + large-scale distributed training experience).

### 4.3 So: can a small applied project honestly demonstrate RL thinking?

**Yes — but only in a narrow, specific, honestly-labelled way. And the temptation to overreach here is
the single largest credibility risk in this whole document.**

What is **not** honest and would be worse than omitting: claiming a training run you did not do;
implementing DPO/GRPO on a toy dataset and describing it as "post-training experience"; calling a
prompt-tuning loop "RLHF"; presenting an LLM-scored preference dataset as a reward model. Every
research engineer who reads the repo will spot it, and it will retroactively taint every honest claim
in the project.

What **is** honest, and maps to a real literature:

1. **Offline policy evaluation (OPE) via replay.** There is a foundational, citable method: Li, Chu,
   Langford & Wang, *Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation
   Algorithms* ([arXiv:1003.5956](https://arxiv.org/abs/1003.5956); WSDM 2011). The replay estimator
   gives a **provably unbiased** offline estimate of a new policy's value from logged data collected
   under a different (ideally randomized) policy. If Signal Zero logs which sources/settlements it
   chose to probe, under what context, with what outcome — and if some fraction of those choices are
   randomized — then a *genuine, correctly-cited, unbiased offline evaluation of an alternative source
   selection policy* is achievable with no training whatsoever. This is real decision-theory work, it
   is defensible in interview, and it is precisely the kind of "distinguish real effects from noise"
   thinking Cognition asks for.

2. **Bandit / active-learning for source selection.** The project's core problem — *which settlement
   should we spend our next expensive Bright Data probe on?* — is literally a budgeted
   exploration/exploitation problem. Thompson sampling or UCB over settlements, with the Gamma-prior
   Exponential time-between-events model already in the codebase acting as the posterior, is honest
   applied decision-making. Claim it as **"bandit-based probe allocation with an explicit
   exploration budget"**, not as "reinforcement learning."

3. **Preference collection design.** Design (and document) the elicitation protocol you *would* use to
   collect human preferences over ranked silence lists — pairwise comparisons, randomized presentation
   order to control the position bias Zheng et al. document, inter-annotator agreement measured with
   precision/recall against a principal expert per Husain. Then actually collect a small set from
   yourself and one other person and report the agreement honestly, including its small-n limits.
   Preference *collection design* is a real, respected skill; it is what reward modelling is built on;
   and doing it well without a training run is not a fake.

**The line to hold in the README:** *"No model was trained for this project. The RL-adjacent work here
is offline policy evaluation of a probe-allocation policy and a documented preference-elicitation
protocol — both cited to their sources. Post-training experience is not claimed."* That sentence will
earn more respect from a research engineer than any amount of RLHF cosplay.

---

## 5. Q4 — OBSERVABILITY FOR LLM SYSTEMS

### 5.1 OpenTelemetry GenAI semantic conventions — verified status

This is the claim most often overstated in portfolio READMEs, so I verified it first-hand rather than
trusting a blog:

- The dedicated repo **`open-telemetry/semantic-conventions-genai`** exists. GitHub API reports it was
  **created 2026-05-05** and last pushed **2026-08-31**.
- Its **releases list is empty** — I queried
  `api.github.com/repos/open-telemetry/semantic-conventions-genai/releases` and it returned `[]`.
  There is **no tagged release and therefore no versioned schema URL to pin against.**
- I fetched the raw model file `model/gen-ai/spans.yaml` from `main` and grepped every `stability:`
  marker. **All 16 are `development`. Zero are `stable`.**
- The core `open-telemetry/semantic-conventions` repo's recent releases are **v1.42.0 (2026-06-12)**,
  **v1.43.0 (2026-07-03)**, **v1.44.0 (2026-08-04)**.

A practitioner write-up consistent with this — John Hodge,
[*The state of the OpenTelemetry GenAI semantic conventions (July 2026)*](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/)
— reports that all GenAI conventions were deprecated in the core repo at **v1.42.0 (12 Jun 2026)** and
moved to the dedicated repo, and states *"no GenAI-specific span, event, metric, or attribute in the
dedicated repository is marked Stable; the GenAI conventions remain Development."* Shared core
attributes such as `error.type` and `server.address` **are** Stable.

**Therefore the accurate sentence is:** *"OpenTelemetry's GenAI semantic conventions are in
Development status as of August 2026, in a dedicated repository with no tagged release; `gen_ai.*`
attributes are not stable and may change."* Saying "we follow the OpenTelemetry GenAI standard" as if
it were settled is a factual error a reviewer can catch in one click.

### 5.2 What teams actually use

From the LangChain survey (n=1,340, Nov–Dec 2025): 89% have observability, 62% detailed tracing;
among production users 94% / 71.5%. That is adoption, not tool share — the survey as I read it did not
give me a clean tool-by-tool market share, and I am not going to invent one.

What I can state about the tools themselves, from primary docs:

- **Langfuse** operates as an **OpenTelemetry backend**, receiving traces on the
  `/api/public/otel` (OTLP) endpoint over HTTP (JSON and protobuf; gRPC not yet supported)
  ([docs](https://langfuse.com/docs/opentelemetry/get-started)). It maps GenAI semconv attributes,
  **OpenInference** attributes, and MLflow conventions onto its data model, with a `langfuse.*`
  namespace taking precedence — and its docs explicitly hedge: *"As the Semantic Conventions for GenAI
  attributes on traces are still evolving…"*. It is open source.
- **Arize Phoenix** is built on OpenTelemetry and **OpenInference** and accepts OTLP. OpenInference is
  itself a set of OpenTelemetry semantic conventions, so any OTel-native backend can ingest
  OpenInference spans. *(This paragraph is from secondary comparison articles, not from Arize's own
  docs — I did not fetch Phoenix's docs directly.)*
- **LangSmith** is LangChain's commercial observability + evals platform; LangChain's own postings
  describe it as *"LangSmith (Observability, Evaluation, Deployment, Fleet, and Sandboxes)"* and they
  are hiring an entire org around *"AI Observability & Evals Platform"* — 47 engineering postings, of
  which many carry that exact team name.
- **Braintrust** ships `braintrustdata/eval-action`, a GitHub Action that runs evals per PR, posts a
  score summary as a PR comment, and can block merge below thresholds. *(Secondary source; I did not
  fetch Braintrust's own docs.)*
- **W&B Weave**: I did **not** verify its OTel status from primary docs. I make no claim about it.

**Market churn to be aware of:** secondary reporting states Helicone was acquired and is in
maintenance mode, Humanloop was sunset after joining Anthropic, and Langfuse joined ClickHouse. I did
not verify these individually; treat as unconfirmed context, not fact.

### 5.3 The minimum credible tracing story for an agent system

**My inference**, synthesised from the postings and the docs above. A reviewer looking at an agent
project's observability should be able to answer these seven questions from the traces alone:

1. **One trace per task, spans per step.** A run produces a single root span; each LLM call, each tool
   call, each retry is a child span with parent linkage. Without this you cannot answer "why did this
   run take 114 seconds?"
2. **Token and cost accounting per span** — input tokens, output tokens, cache reads, and a derived
   cost. Anthropic's Performance Engineer posting demands turning *"raw telemetry into clear findings"*;
   Modal's ML Performance posting wants a *story* about where the time went.
3. **Latency broken down by layer**, so a regression can be attributed. Signal Zero already has a
   37s → 114s regression and a tier-3 15,000 ms turn timeout. That regression is *an asset* if the
   traces explain it and *a liability* if they don't.
4. **Tool-call outcome as a first-class attribute** — success / schema-validation failure / timeout /
   guardrail-blocked / human-denied. This is what makes tool reliability measurable.
5. **Guardrail decisions traced**, with the rule ID that fired (Signal Zero already emits
   `injection.invisible-characters` — that belongs in a span attribute, not just a log line).
6. **Trace ID surfaced in the UI and in eval output**, so a failing eval case links to the exact trace.
   This is the practical realisation of Husain's *"remove all friction from the process of looking at
   data."*
7. **Export over OTLP** to a backend the reviewer can run (Langfuse self-hosted, or Phoenix), with
   `gen_ai.*` attributes emitted **and labelled as Development-status conventions**.

Winston logging alone answers none of 1, 3, 4, or 6.

---

## 6. Q5 — WHAT SIGNALS SENIORITY

### 6.1 The levelling frameworks

Published, primary career frameworks agree on the axis, and it is not "knows more technologies."

**Dropbox Engineering Career Framework** ([dropbox.github.io/dbx-career-framework](https://dropbox.github.io/dbx-career-framework/)):

- **IC3**: owns and delivers projects against quarterly goals; *"independently identify the right
  solutions to solve ambiguous, open-ended problems"*; *"Independently design software components in
  well scoped scenarios."*
- **IC4 (Senior)**: scope moves to *"semi-annual/annual goals for my team"*; *"an expert at identifying
  the right solutions to solve ambiguous, open-ended problems"*; makes *"independent technical
  decisions in the face of open-ended requirements"*; *"define[s] the technical roadmap for impactful
  multi-phase projects"*; and creates *"coherent designs with multiple components interacting across
  API or system boundaries."* Influence is *"beginning to extend outside my team."*

**Levels.fyi standard SWE framework** ([levels.fyi/blog/swe-level-framework.html](https://www.levels.fyi/blog/swe-level-framework.html)):
Senior (L4) is described as a *"career-level"* where most engineers spend their careers, owning
*"moderate to complex components"* and delivering *"small projects end-to-end"*. Staff (L5)
*"generally pivots more towards design than implementation"* and owns *"complex technical
initiatives"* with organisation-wide influence.

The common axes across both, and across the Monzo and GitLab frameworks aggregated at
[progression.fyi](https://progression.fyi/): **scope of impact**, **amount of ambiguity handled**, and
**degree of autonomy** — not effort, not tool count.

### 6.2 What the postings themselves treat as senior signals

This is more useful than any levelling guide, because it is what the hiring companies wrote down:

- **Owning outcomes, not recommendations.** LangChain Deployed Engineer: *"Take responsibility for
  outcomes, not just recommendations."*
- **Saying no.** Anthropic Performance Engineer: *"Ruthlessly stack-rank a large surface area of
  opportunities by impact and effort, and **say no** to the ones that don't make the cut."*
- **Tradeoff articulation.** Sierra Agent Architecture asks for steerable *and* verifiable *and*
  adaptive — and expects you to reason about the tension. Modal's Research Inference role names
  *"acceptance length is the metric that decides the win"* — i.e. picking the metric is the senior act.
- **Correctness held equal to speed.** Anthropic Inference Systems: *"performance engineers who treat
  correctness as part of performance."*
- **Debugging across owned/unowned boundaries.** Anthropic Model Evaluations: *"Debug anomalous eval
  results mid-training-run, determine whether the cause is a model change or an infrastructure issue."*
  Anthropic AIRE: *"comfortable jumping into unfamiliar systems during an incident."*
- **Writing.** Anthropic Model Evaluations lists as a *minimum* qualification *"Clear written and
  verbal communication, especially when explaining technical results to non-specialists."*
  Anthropic Performance Engineer: *"Ability to communicate quantitative results clearly in writing."*
- **Building things others build on.** Modal Research Inference: *"A record of shipping research or
  systems that other people build on."*

### 6.3 What reads as bootcamp capstone vs. what reads as senior

**This table is my inference**, derived from §6.1 and §6.2. I want to flag clearly that the
"portfolio project advice" genre online is dominated by low-quality SEO content — I searched it, read
it, and am deliberately **not** citing it, because none of it is a primary source and most of it is
generated listicles. The distinctions below are derived from published levelling frameworks and from
what employers literally wrote in postings.

| Reads as capstone | Reads as senior |
|---|---|
| Feature list in the README | Stated problem, stated constraints, stated tradeoffs, stated things deliberately not built |
| "Uses GPT-4 for X" | "Chose deterministic Fellegi-Sunter over an LLM for record linkage because X; here is the eval that shows it" |
| Green tests, no failures shown | A documented regression with a root cause, and a measurement of the fix |
| Claims of reliability | An SLO, a measured p95, and an incident write-up |
| Happy-path demo | Adversarial cases in CI that fail the build |
| "Production-ready" in prose | A CI pipeline, a container, a health check, and persisted state |
| Every buzzword present | Explicit "we did NOT do X, because Y" statements |
| No upstream engagement | A root-caused upstream bug, filed, with a reproduction |

Signal Zero already has several of the right-hand column — the TrueForge Windows ESM crash root-caused
to kysely's `FileMigrationProvider`, the silently-dropped `compaction.trigger`, and the deterministic
statistics chosen over LLM calls. **Those are its strongest senior signals and they are currently
buried in `docs/`.**

---

## 7. What Signal Zero must add or change — prioritised

Context: 195 tests, 157 eval checks (19 tracked files, 4 families), deterministic guardrails, 5 registered agents on a self-hosted
TrueForge harness, verified human-in-the-loop tool approval, real per-turn telemetry, three genuine
statistical methods (Fellegi-Sunter, Exponential/Gamma time-between-events, Getis-Ord Gi*). Verified
gaps: no CI, no Dockerfile, no IaC, no linter, no types, in-memory store, no metrics/tracing, no
LICENSE/SECURITY.md, no load testing, no authn/z, and a 37s → 114s pipeline regression with a tier-3
15s turn timeout.

Ordering is by *evidence-weighted return on effort* for the AI/Agent Engineer bar (§1.1), which is the
family this project can actually clear.

### Tier 0 — Do these first. Their absence is disqualifying, and each is cheap.

1. **CI that runs tests AND evals, and fails the build.**
   `.github/workflows/ci.yml` running `npm test` and `npm run eval:strict` with a threshold gate.
   *Why:* OpenAI's Evals posting asks literally for *"continuous eval monitoring frameworks
   (regression/drift monitoring…)"*; Braintrust and Promptfoo exist as products because merge-blocking
   eval gates are the practice. A repo with 157 eval checks (19 tracked files, 4 families) and no CI reads as "wrote evals for the
   README." **Highest signal-per-hour item in this list, by a wide margin.**

2. **A LICENSE file, and a SECURITY.md that is actually about LLM security.**
   The LICENSE is 30 seconds. The SECURITY.md should state the threat model in the **lethal trifecta**
   vocabulary: which of {private data, untrusted content, exfiltration vector} this system has, which
   it has architecturally removed, and — critically — that prompt injection is **not** solved, citing
   Willison. Map the guardrail rules to **LLM01:2025** and **LLM06:2025** by their exact identifiers.
   *Why:* this converts an existing asset (deterministic guardrails, observed blocking
   `injection.invisible-characters`) into a security-literacy signal, and the honesty about
   non-solution is itself the senior move.

3. **Fix, or fully explain, the 114s regression.**
   Right now it is a liability. With a trace-backed root-cause write-up — where the time went, why the
   tier-3 15,000 ms timeout fires, what the fallback costs in quality — it becomes the project's best
   *senior* artefact, because it demonstrates exactly the debugging Anthropic's Model Evaluations and
   AIRE postings describe. Do not ship it silently regressed with no explanation.

4. **Dockerfile + `docker compose up` that works.**
   Every infra-adjacent posting assumes containerisation. A reviewer who cannot run the project in one
   command will not run it. This is table stakes, not a differentiator — which is why it's Tier 0 and
   not Tier 1.

### Tier 1 — These are what actually clear the senior AI-engineering bar.

5. **OTLP tracing, one root span per pipeline run, child spans per LLM/tool call.**
   Export to self-hosted **Langfuse** (OTel backend on `/api/public/otel`, open source) or Phoenix.
   Emit `gen_ai.*` attributes **and write in the docs that these conventions are Development status,
   in `open-telemetry/semantic-conventions-genai`, with no tagged release** — that sentence alone
   distinguishes you from every candidate who wrote "OpenTelemetry-compliant." Include token counts,
   cache reads (you already measure 32,032 of 33,242), latency per layer, tool outcome, and the
   guardrail rule ID that fired. Surface the trace ID in the UI and in eval output.
   *Why:* observability is the highest-adoption practice in the LangChain survey (89%), it is the only
   way item 3 becomes legible, and Signal Zero already collects the raw numbers — it just isn't
   emitting them as traces.

6. **Upgrade the eval suite from "many files" to "statistically defensible."**
   Concretely, and each of these is cited above:
   - Report **standard errors** on every golden-set accuracy number, and **paired differences** between
     variants rather than independent comparisons (Miller, arXiv:2411.00640).
   - Where an LLM judge is used, make it **binary pass/fail with a written critique**, validate it
     against your own human labels, and report **precision and recall separately, not raw agreement**
     (Husain).
   - Add a **held-out split** you do not iterate on (Anthropic, *Writing effective tools for agents*).
   - Measure **beyond accuracy**: total runtime, tool-call count, token cost, and **omissions** — the
     Anthropic tools post argues *"what agents omit…can often be more important than what they
     include."* For a silence-ranking system, omission is literally the domain.
   - Publish a **failure taxonomy** derived from real observed failures, with a test per category.
   *Why:* this is the single largest gap between "157 eval checks (19 tracked files, 4 families)" and what Cognition means by *"making
   sure the numbers mean something."*

7. **Persistence.** In-memory state that dies on restart contradicts every reliability claim the
   project makes. SQLite is sufficient; the point is that a restart does not lose the silence clock,
   which is the entire product thesis. *Why:* a time-since-last-report system that forgets time on
   restart is a correctness bug, not a missing feature — and Anthropic's inference posting frames
   correctness as part of performance.

8. **A per-tool risk classification with human approval on the high-risk tier.**
   You already have verified `tool.approval_required → user.tool_approval → tool.response`. Formalise
   it: rate each of the 5 Bright Data MCP tools low/medium/high on OpenAI's stated axes (read-only vs
   write, reversibility, permissions, financial impact), gate high-risk on approval, and cite
   **LLM06:2025**'s "require user approval" mitigation and MCP's *"SHOULD always be a human in the loop
   with the ability to deny tool invocations."* *Why:* this turns a demo feature into an argued
   security control, which is exactly the difference between the two columns in §6.3.

9. **An SLO section with measured p50/p95 latency and an error budget.**
   Directly mirrors Anthropic AIRE's *"Develop appropriate Service Level Objectives for large language
   model serving systems, balancing availability and latency with development velocity."* Cheap once
   item 5 exists.

### Tier 2 — Real differentiators, if time permits.

10. **The honest RL-adjacent work (§4.3).** Implement bandit-based probe allocation over settlements
    with an explicit exploration budget, log the decisions with the randomization, and run a **replay
    offline policy evaluation** of an alternative allocation policy, citing Li et al. (arXiv:1003.5956).
    Write the README paragraph that says plainly: *no model was trained; this is OPE and bandit
    allocation, not post-training.* **Do this only if you do it correctly and label it correctly.**
    Done well it is genuinely rare in a portfolio. Done sloppily it is worse than omitting.

11. **A written design document with tradeoffs and non-goals.**
    Why Fellegi-Sunter instead of an LLM for linkage. Why Getis-Ord Gi* over a river-corridor adjacency
    graph instead of a naive grid. Why silence-ranking instead of volume-ranking, and where that
    inverts and fails. What the system does **not** do. *Why:* Dropbox IC4 asks for *"coherent designs
    with multiple components interacting across API or system boundaries"*; Anthropic lists clear
    written communication as a **minimum** qualification.

12. **Types.** Not a TypeScript rewrite — JSDoc types plus `tsc --checkJs` in CI gets ~80% of the
    signal for ~10% of the work. Machinify literally asks for *"type discipline."*

13. **Linter/formatter config.** Cheap, and its absence reads as carelessness in a repo that otherwise
    argues for rigour.

### Do NOT bother — these would read as padding

- **Kubernetes / Terraform / full IaC.** Signal Zero is a single Node service. A Helm chart for a
  single-container app reads as résumé-driven development, and infra reviewers will recognise it as
  such. A Dockerfile and a `compose.yml` are the honest ceiling here.
- **A TypeScript rewrite.** High cost, low marginal signal over `checkJs`. It would also churn a
  codebase whose real strength is the statistics and the guardrails.
- **A frontend framework migration.** "No build step, vanilla JS, MapLibre" is a *defensible taste
  decision* you can argue for. Migrating to React to look modern discards that argument and gains
  nothing — no AI-engineering posting in my sample asked for a specific frontend framework.
- **Authentication/authorization.** For a public read-only dashboard there is no asset to protect.
  Adding auth invites the question "protecting what?" **Instead**, write one paragraph in SECURITY.md
  saying auth is out of scope because the system holds no user data and exposes no write path — that
  is a stronger signal than a bolted-on login.
- **Load/performance testing at scale.** k6 numbers on a demo dataset prove nothing, and the infra
  family (§1.4) will not be fooled by them. Fixing the 114s regression with traces is worth ten times
  more than a synthetic throughput chart.
- **Fine-tuning a model, or any DPO/GRPO implementation.** Per §4, no application-role posting in a
  ~2,700-posting sample requires it; Sierra's 52 engineering postings never mention it. A toy training
  run would invite exactly the scrutiny it cannot survive. **Omit it, and say in the README that you
  omitted it deliberately.**
- **Adding more agents, more tools, or more MCP servers.** Five agents and five tools already exceed
  what most portfolio projects show. Breadth is not the axis being measured; §6.1's axis is scope,
  ambiguity, and autonomy. Depth on evaluation and reliability beats another integration.
- **CHANGELOG.md / CONTRIBUTING.md.** For a solo portfolio project with no contributors these are
  ceremony. LICENSE and SECURITY.md are not — they carry actual information. Skip the other two.

### The one-line positioning that the evidence supports

Signal Zero is not an ML project and should stop trying to be one. It is an **agent-reliability and
evaluation-methodology project** with unusually real statistical machinery underneath and a genuine
human-in-the-loop tool-approval path. That is precisely the AI/Agent Engineer bar described in §1.1 —
*"you don't ship without an eval"* (Machinify), *"harnesses, execution flows, and guardrails that make
AI systems reliable in production"* (Baseten), *"evaluation and monitoring systems for agents"*
(LangChain, required). Tier 0 and Tier 1 above are what turn the existing work into that claim.

---

## 8. Sources

**Job postings fetched directly (primary).**
[Anthropic — Research Engineer, Model Evaluations](https://job-boards.greenhouse.io/anthropic/jobs/5198255008) ·
[Anthropic — Research Engineer, Code RL](https://job-boards.greenhouse.io/anthropic/jobs/5254364008) ·
[Anthropic — Forward Deployed Engineer](https://job-boards.greenhouse.io/anthropic/jobs/5391016008) ·
[Anthropic — Applied AI Engineer](https://job-boards.greenhouse.io/anthropic/jobs/5390799008) ·
[Anthropic — Staff Software Engineer, AI Reliability](https://job-boards.greenhouse.io/anthropic/jobs/5113224008) ·
[Anthropic — Performance Engineer, Inference Systems](https://job-boards.greenhouse.io/anthropic/jobs/5224564008) ·
[Anthropic — TLM, Agent Runtime Platform](https://job-boards.greenhouse.io/anthropic/jobs/5316593008) ·
[OpenAI — Research Engineer, Frontier Evals & Environments](https://jobs.ashbyhq.com/openai/bba18df5-f30f-4d2c-909c-30e651f95579) ·
[OpenAI — Backend Software Engineer (Evals)](https://jobs.ashbyhq.com/openai/3d064454-c0c3-4225-bc2c-6d8c0f8735b2) ·
[OpenAI — Software Engineer, Agent Infrastructure](https://jobs.ashbyhq.com/openai/c1316397-25bb-4add-9e9d-0e3ea8ba929a) ·
[OpenAI — Security Engineer, Agent Security](https://jobs.ashbyhq.com/openai/e9bea775-7eb6-438a-ab96-27d5f941e69d) ·
[OpenAI — Applied AI Engineer, Startups](https://jobs.ashbyhq.com/openai/71e7252f-abb1-4b74-8e69-318413042357) ·
[Sierra — Software Engineer, Agent Architecture](https://jobs.ashbyhq.com/Sierra/b3829801-8e0b-4047-8cd8-8a51c87028fd) ·
[Sierra — Software Engineer, Agent (London)](https://jobs.ashbyhq.com/Sierra/b7d1dbcd-ca72-472f-b15e-5b4b0f886be0) ·
[Sierra — Software Engineer, Intelligence](https://jobs.ashbyhq.com/Sierra/f4319197-e898-4756-a7f2-af884fe1e0c7) ·
[LangChain — Fullstack Software Engineer, Applied AI](https://jobs.ashbyhq.com/langchain/c75915ba-a32b-4e17-873d-19b47564170d) ·
[LangChain — Research Engineer, LangSmith Engine](https://jobs.ashbyhq.com/langchain/bdc96ffd-2a95-4d63-bf8f-193574961e00) ·
[LangChain — AI Engineer, Enablement](https://jobs.ashbyhq.com/langchain/47ad420c-9302-4a4f-a35f-7dd29e1d9d28) ·
[LangChain — Deployed Engineer (Bay Area)](https://jobs.ashbyhq.com/langchain/e773649c-4ea7-47c2-9987-74d525474e82) ·
[Cognition — Research Engineer, Post-Training](https://jobs.ashbyhq.com/cognition/72d3db28-07d3-4c28-b49f-1bdf6e8e0f10) ·
[Cognition — Applied AI Engineer](https://jobs.ashbyhq.com/cognition/811c3f5a-b26d-4162-b49b-93890a91794d) ·
[Modal — MTS, ML Performance](https://jobs.ashbyhq.com/modal/af17da5e-23ca-4802-854d-5f0546e1ed32) ·
[Modal — MTS, Research, Inference](https://jobs.ashbyhq.com/modal/73c97bbc-8e27-4c5d-b38b-90b3afdb0d93) ·
[Modal — Forward Deployed Engineer, ML](https://jobs.ashbyhq.com/modal/9fadb51f-ce11-41b1-84d5-470e66cc8ee9) ·
[Baseten — Software Engineer, Baseten Inference Stack](https://jobs.ashbyhq.com/baseten/c8701794-bdc1-4932-bffa-a444ce57ed73) ·
[Baseten — AI Engineer](https://jobs.ashbyhq.com/baseten/b13ec426-d09d-4122-8112-cf25adbd7d60) ·
[Baseten — Forward Deployed Engineer](https://jobs.ashbyhq.com/baseten/84c1801c-1a65-49fb-aaaa-beeafd530e7e) ·
[Anyscale — Distributed LLM Inference Engineer](https://jobs.ashbyhq.com/anyscale/1cf38233-8aa0-47f8-9d85-65ce27bc3047) ·
[Scale AI — ML Research Scientist, Evaluations](https://job-boards.greenhouse.io/scaleai/jobs/4728014005) ·
[Databricks — Staff Machine Learning Engineer](https://databricks.com/company/careers/open-positions/job?gh_jid=8401114002) ·
[Databricks — Staff Research Engineer, Data Agents](https://databricks.com/company/careers/open-positions/job?gh_jid=8604954002) ·
[Databricks — Senior Staff Applied AI Engineer, Context Retrieval](https://databricks.com/company/careers/open-positions/job?gh_jid=8540267002) ·
[Google DeepMind — Research Engineer, Human Understanding](https://job-boards.greenhouse.io/deepmind/jobs/7669433) ·
[Machinify — AI Engineer, Agentic Systems](https://job-boards.greenhouse.io/machinifyinc/jobs/4146862009) ·
[Future — Applied AI Engineer](https://job-boards.greenhouse.io/future/jobs/4683133005) ·
[Harvey — Staff Applied AI Engineer (BuiltIn mirror; posting removed 31 Jan 2026)](https://builtin.com/job/applied-ai-engineer/7391432)

**Specifications and standards.**
[OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) ·
[OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) ·
[MCP specification 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) ·
[MCP specification 2025-11-25 — Security Best Practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) ·
[open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) (verified via GitHub API: created 2026-05-05, zero releases; `model/gen-ai/spans.yaml` — all stability markers `development`)

**Engineering blogs and reports.**
[Anthropic — Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) ·
[Anthropic — Writing effective tools for agents (11 Sep 2025)](https://www.anthropic.com/engineering/writing-tools-for-agents) ·
[Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
[OpenAI — A practical guide to building agents (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) ·
[Hamel Husain — Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) ·
[Hamel Husain — Using LLM-as-a-Judge For Evaluation](https://hamel.dev/blog/posts/llm-judge/) ·
[Simon Willison — The lethal trifecta for AI agents (16 Jun 2025)](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) ·
[LangChain — State of Agent Engineering (n=1,340; 18 Nov–2 Dec 2025)](https://www.langchain.com/state-of-agent-engineering) ·
[Langfuse — OpenTelemetry docs](https://langfuse.com/docs/opentelemetry/get-started) ·
[Langfuse — LLM regression testing](https://langfuse.com/resources/engineering/llm-regression-testing) ·
[John Hodge — State of the OpenTelemetry GenAI semantic conventions (Jul 2026)](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/) ·
[Sierra — Meet the AI agent engineer](https://sierra.ai/blog/meet-the-ai-agent-engineer)

**Papers.**
[Miller — Adding Error Bars to Evals (arXiv:2411.00640)](https://arxiv.org/abs/2411.00640) ·
[Zheng et al. — Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena (arXiv:2306.05685)](https://arxiv.org/abs/2306.05685) ·
[Li, Chu, Langford & Wang — Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation Algorithms (arXiv:1003.5956; WSDM 2011)](https://arxiv.org/abs/1003.5956) ·
Beurer-Kellner et al. — *Design Patterns for Securing LLM Agents against Prompt Injections*, arXiv:2506.08837 — **referenced only, not fetched**

**Levelling frameworks.**
[Dropbox Engineering Career Framework — IC3](https://dropbox.github.io/dbx-career-framework/ic3_software_engineer.html) ·
[Dropbox Engineering Career Framework — IC4](https://dropbox.github.io/dbx-career-framework/ic4_software_engineer.html) ·
[Levels.fyi Standard SWE Level Framework](https://www.levels.fyi/blog/swe-level-framework.html) ·
[progression.fyi](https://progression.fyi/)
