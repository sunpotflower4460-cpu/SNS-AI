# Low-Cost Research Pipeline

This describes the research architecture introduced to reduce OpenAI Web Search / X API spend before the
first production account (`music-tools-x`) goes live. It changes **only** how research candidates are
gathered and scored; it does not change Manual-Only posture, does not enable any account, and does not
change posting cadence or approval requirements.

## Why

The previous default was "call OpenAI Web Search, then look at X" for every research pass. Web Search and
broad X data collection are the most expensive parts of this pipeline. Most useful information about
plugin releases, sales, and free giveaways is already available for free as RSS/Atom feeds, GitHub
Releases, and official vendor pages — no AI call is needed just to *discover* that a release exists.

## Pipeline

```
Scheduler (SNS Trend Intelligence, workflow_dispatch only)
  -> Source Registry (config/research-sources.json)
  -> Direct Fetchers (Tier 1: RSS/Atom, GitHub Releases — src/research/sources/*.mjs)
  -> Normalize (src/research/sources/normalize.mjs)
  -> Cache / Deduplicate (src/research/cache.mjs, data/research-cache/<account>.json)
  -> Cheap AI triage (Tier 2: src/research/triage.mjs via src/ai/provider.mjs, Groq by default)
  -> if too few fresh candidates: OpenAI Web Search fallback (Tier 3: existing generateTrendBrief)
  -> Trend Brief (data/trends/<account>.json) — same shape either path produces
  -> existing SNS candidate generation / ranking / learning (unchanged)
  -> X posting (unchanged; URL usage additionally gated by linkPolicy)
```

An account only enters this pipeline if `research.directFetch: true`. Every other account (including
every account that predates this change) keeps calling OpenAI Web Search directly, exactly as before —
this is strictly additive.

## Source Registry

`config/research-sources.json` maps an account id to an array of sources:

```json
{
  "music-tools-x": [
    { "id": "vendor-feed", "type": "rss", "url": "https://vendor.example/feed.xml", "priority": 80, "categories": ["plugin", "sale"] },
    { "id": "acme-releases", "type": "github-releases", "owner": "acme", "repo": "plugin", "priority": 60 }
  ]
}
```

- `type`: `rss`, `atom`, or `github-releases`.
- `enabled: false` disables a source without deleting it.
- `priority` (optional, higher first) only affects fetch order, not filtering.
- `src/research/sources/registry.mjs` validates this file's shape; a malformed entry is a config error the
  same way `npm run validate` catches other config mistakes.

Add sources by editing this file — there is no code change needed to add a new vendor's RSS feed or GitHub
repository. This is designed to scale to tens or hundreds of sources per account.

## Adapters (Tier 1)

- `src/research/sources/rss.mjs` — a small dependency-free RSS 2.0 / Atom item extractor (this repository
  has zero npm dependencies by design; see `package.json`). Fetches through
  `src/lib/http.mjs`'s SSRF-hardened `fetchPublicHttps`.
- `src/research/sources/github-releases.mjs` — GitHub's public Releases API (`api.github.com`, a fixed
  trusted host), skips drafts, keeps the release tag as the version identity for cache/dedup.

Every adapter normalizes into the same shape (`src/research/sources/normalize.mjs`):

```
{ sourceId, sourceType, title, url, publishedAt, fetchedAt, vendor, product, summary, rawText, categories, metadata }
```

One dead source (a 404 feed, DNS failure, GitHub rate limit) never aborts the run —
`src/research/fetch-pipeline.mjs` isolates each source in its own try/catch and records the failure to
`data/audit.jsonl` (`stage: "research-source-failed"`); the account still runs on whatever other sources
succeeded.

## Cache / Deduplication

`src/research/cache.mjs` stores, per account, a hash of each candidate's identity (URL, title, vendor,
product, version/release tag — **not** the full text, so an unrelated copy-edit doesn't count as a new
item). Once a candidate's hash has been scored by AI triage (`evaluatedAt` set), it is never sent to AI
again — a vendor blog post or GitHub release that a scheduled run sees again 6 hours later is skipped for
free, not re-billed to Groq/OpenAI. A version bump (new release tag, changed URL) is treated as new content
and is evaluated again.

## Cheap AI triage (Tier 2)

`src/research/triage.mjs` scores fresh candidates through `src/ai/provider.mjs`, which tries providers in
order (Groq by default, OpenAI as fallback) and asks for `relevance`, `novelty`, `usefulness`, `priceValue`,
`newsworthiness`, `japanNovelty`, `audienceFit`, `confidence`, and `risk` — never inventing a price, date,
feature, or fact not present in the fetched title/summary. The result is shaped identically to the existing
OpenAI Web Search trend brief (`summary`, `items`, `citations`), so ranking, persistence, and downstream
post generation (`src/lib/openai.mjs generatePost()`) do not need to know which path produced it.

`src/research/trends.mjs`'s `opportunityScore` ranking is backward compatible: an item with no
`japanNovelty`/`audienceFit` (every existing Web Search brief) keeps the exact original weighting; only
items from the new triage path use the richer weighting.

## Web Search fallback (Tier 3)

If `research.directFetch` is not `true` for an account, or direct fetch produced fewer than
`research.minDirectCandidates` fresh candidates, `refreshTrends()` falls back to the existing OpenAI Web
Search-based `generateTrendBrief()` exactly as before. This is a fallback, not the default entry point —
Web Search is never called first for a `directFetch: true` account.

## Groq / OpenAI provider abstraction

- `src/ai/provider.mjs` — chooses providers per account/task (`account.ai.providers`,
  `account.ai.tasks.<task>.providers`), falls forward on failure (missing key, exhausted budget,
  transient error) unless `account.ai.allowFallback === false`.
- `src/ai/groq.mjs` — Groq's OpenAI-compatible chat completions API, budgeted through the same
  `src/ops/budget.mjs` mechanism as every OpenAI call, under its own `budgets.groqCallsPerDay` limit and
  `'groq'` usage kind.
- `src/ai/openai-task.mjs` — the OpenAI-side implementation of the same cheap-task interface, reusing
  `src/lib/openai.mjs`'s existing transport (so budget consumption/retries stay identical to every other
  OpenAI call in this repository) with a smaller/cheaper model (`gpt-5-mini` by default).
- `GROQ_API_KEY` is entirely optional. Missing it, or any Groq failure, falls forward to OpenAI —
  **OpenAI-only configurations keep working exactly as before.** OpenAI integration itself
  (`src/lib/openai.mjs generatePost/generateTrendBrief/moderateText`) is unmodified; Groq is additive.

High-quality final post generation (`generatePost()` in `src/lib/openai.mjs`) is unchanged and still goes
through OpenAI's Responses API — this pipeline only changes what feeds the *research/trend* step that
generation optionally reads (`context.trends`).

## URL post budget (linkPolicy)

See the README's "URL付き投稿の予算管理" section and `src/research/link-policy.mjs` /
`src/content/link-gate.mjs`. In short: `account.linkPolicy` caps how many published posts per day/week may
contain a URL, and restricts which `features.linkPurpose` values are allowed to use one. A draft that
exceeds the cap is not discarded — only its URL is stripped before publishing. Accounts without
`linkPolicy` configured are unaffected (unlimited, exactly as before this change).

## Cost visibility

`npm run cost-report` (`src/reports/cost-report.mjs`) reports, per account: direct-fetch/RSS/GitHub item
counts, duplicate drops, today's Groq/OpenAI/Web Search/media call counts (from the existing budget
ledger), and — for X accounts — published URL vs. non-URL post counts over the last 30 days plus an
estimated monthly cost using the operator-maintained `config/x-api-pricing.json` pricing model (defaults to
all zeros; fill in real tier pricing to get a meaningful estimate). None of this is real X billing data.

## What this change does NOT do

- It does not enable `music-tools-x` or any account, and does not touch `config/runtime-policy.json`'s
  `manualOnly: true`.
- It does not add scheduled/automatic engagement (reply/DM/like/follow) — still disabled repository-wide.
- It does not apply for or register any affiliate program. `src/research/link-policy.mjs`'s
  `resolveLinkUrl()` only *prepares* an official-URL/affiliate-URL switch for a future, separate rollout;
  affiliate monetization stays `enabled: false` for `music-tools-x`.
- It does not remove or replace OpenAI. Groq is an additional, optional, cheaper provider for
  triage-style tasks only.
