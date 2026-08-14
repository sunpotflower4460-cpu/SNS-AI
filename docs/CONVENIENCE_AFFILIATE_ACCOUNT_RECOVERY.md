# Convenience discovery / affiliate account recovery brief

This file is the durable planning source of truth for the future **convenience discovery / affiliate brand** in SNS-AI.

The brand is planned as a paired presence on **X + Instagram**, backed by a dedicated always-current discovery Hub. Exact public account names and final account IDs are intentionally undecided. Provisional internal IDs may later be `convenience-discovery-x` and `convenience-discovery-instagram`, but this document alone must not create or enable live accounts.

Everything below is **account-specific** to this convenience-discovery brand unless explicitly described as shared SNS-AI infrastructure. Do not copy its persona, product-selection policy, Hub behavior, monetization density, or editorial voice into unrelated accounts by default.

## One-sentence concept

**「こんな便利なものがあるんだ」を見つける。**

Audience-facing brand copy candidate:

**知らなかった便利、見つけました。**

The account is not intended to be a generic discount feed, coupon feed, product-ranking site, or an account that posts whatever happens to pay the highest commission.

Its value is:

**discovery + utility + quick fit judgment + a trustworthy path to act.**

The primary emotional reaction the account should create is:

**「そんなものあったんだ。ちょっと便利そう。」**

## Primary persona

Core reader:

**困っているほどではない。でも、もっとラクになる方法があるなら知りたい人。**

Typical context:

- likes useful products, services and small life improvements
- is not actively shopping for every item that appears in the feed
- dislikes spending hours reading comparison pages before every minor purchase
- responds well when a product solves a familiar annoyance in a surprisingly simple way
- wants the account to explain what the thing actually does before asking for a click
- does not want constant hard-sell language, false urgency, or exaggerated “must buy” claims
- may save a discovery now and return to it later when the need appears

The main follow reason is:

**「自分では探していなかった便利なものが、勝手に見つかる。」**

## Editorial personality

The voice should feel like **a curious person who keeps finding unexpectedly useful things**, not a salesperson chasing a quota.

Preferred tone examples:

- 「こんなのあるんだ。」
- 「これ、地味だけどかなり便利そう。」
- 「毎回ここが面倒な人には合いそう。」
- 「逆に○○しない人なら多分いらない。」
- 「似たものはあるけど、ここがちょっと違う。」

Avoid:

- “絶対買うべき”
- fake first-hand use
- fabricated reviews or testimonials
- manufactured scarcity
- unsupported health / financial / performance claims
- every post beginning with a discount percentage
- hiding affiliate relationships
- turning the feed into a wall of product links

## Monetization stance

Unlike `music-tools-x`, this account is explicitly designed to be **affiliate-connected from the beginning of live operation**.

Affiliate connectivity is normal for this brand, but recommendation quality remains independent from commission.

Required order:

**discover → verify → score utility → decide to feature → resolve approved affiliate route → disclose → publish → measure**

Never use:

**commission rate → recommendation rank**

Commission/revenue may be measured after editorial selection for business reporting, CTA experiments, Hub layout experiments, and provider reliability analysis, but it must not decide which product is considered better for the reader.

A useful product may still be featured when no affiliate route exists if it has exceptional discovery value. Conversely, the existence of an affiliate route never makes a weak product eligible by itself.

## Product universe

The account may cover a broad range of products and services as long as each item passes the same core test:

**the user should be able to understand the practical convenience in a few seconds.**

Examples of acceptable editorial areas:

- small household conveniences
- time-saving tools
- desk / work accessories
- travel conveniences
- storage and organization
- useful gadgets
- apps and web services
- subscriptions with a concrete utility
- food or household services that remove a repeated chore
- creator / work tools that are understandable to a general audience
- low-cost items with unusually high convenience
- free tools/services with real utility
- unusual products whose existence itself is the discovery

Do not force the account into one retail category unless real performance data later shows that a narrower identity produces significantly better retention without destroying the discovery concept.

## Discovery sources

Candidate discovery should be multi-source and provider-agnostic.

Possible source classes:

1. approved affiliate provider catalogs / feeds / APIs
2. approved merchant or advertiser catalogs
3. official manufacturer / service pages
4. marketplace search where terms permit it
5. current trend / product discovery research
6. specialist publications and product-launch sources
7. user questions and repeated “is there something that does X?” needs
8. existing Hub items that have a newly discovered better alternative

Affiliate catalogs are **candidate sources**, not the editorial truth.

A candidate should be re-verified against a current official product/service source before publication when practical, especially for price, availability, functionality, subscriptions, campaign terms, compatibility, and time-limited claims.

## Canonical product model

Future implementation should normalize every candidate into one product object rather than letting provider-specific payloads leak into editorial logic.

Suggested shape:

```json
{
  "productId": "stable-internal-id",
  "name": "...",
  "brand": "...",
  "category": "...",
  "problemSolved": "...",
  "convenienceInOneSentence": "...",
  "whyInteresting": "...",
  "whoFor": ["..."],
  "whoCanSkip": ["..."],
  "officialUrl": "...",
  "sourceEvidence": [],
  "pricing": {
    "value": null,
    "currency": null,
    "verifiedAt": null
  },
  "availability": "unknown",
  "discovery": {
    "firstSeenAt": "...",
    "lastVerifiedAt": "...",
    "sourceClass": "..."
  },
  "scores": {},
  "affiliateRoutes": [],
  "hub": {},
  "history": {}
}
```

Separate **product identity** from **offer identity**. The same product may have Amazon, Rakuten, ASP, official/direct, or other offers without becoming multiple editorial products.

## Product discovery pipeline

### Stage 1 — Candidate ingestion

Gather a broad candidate pool without posting.

Persist:

- source
- discovery timestamp
- canonical URL
- merchant / brand
- category
- any initial affiliate availability
- source confidence

Deduplicate obvious URL, SKU, brand+model, and normalized-name collisions before paying for deeper analysis.

### Stage 2 — “What convenience does this create?” extraction

Every candidate must answer these questions clearly:

1. What repeated annoyance or task does it remove/reduce?
2. Can that usefulness be explained in one sentence?
3. Is the convenience materially different from a normal/common solution?
4. Can a reader recognize whether it applies to them without reading a long review?
5. Is the claim supported by verifiable product/service information?

If the system cannot produce a concrete `problemSolved` + `convenienceInOneSentence`, reject or defer the candidate.

### Stage 3 — Hard rejection filters

Reject or require human review when any of the following applies:

- unverifiable core claims
- deceptive before/after claims
- clearly counterfeit or rights-infringing goods
- unsafe or prohibited product classes under platform / affiliate / OpenAI policy
- medical or financial claims that cannot be handled safely
- recurring billing or cancellation conditions that cannot be verified
- manipulative scarcity or fake urgency
- major privacy / surveillance concerns
- product/service page no longer available
- seller/merchant identity cannot be established sufficiently
- the only reason to feature it is unusually high commission

### Stage 4 — Convenience Discovery Score

Use a category-based score instead of a single opaque “AI knows best” judgment.

Recommended dimensions (0–100):

- `discoverySurprise` — likelihood the target reader says “こんなのあるんだ”
- `practicalUtility` — real reduction in friction/time/effort
- `clarity` — usefulness understandable in seconds
- `evidenceStrength` — quality of current verifiable support
- `audienceFit` — fit for the core persona
- `valueSense` — value relative to price/commitment, without requiring “cheap”
- `distinctiveness` — not just another near-identical item recently featured
- `shareability` — likely to be sent/saved because the existence is interesting
- `risk` — claims/merchant/terms/quality uncertainty; lower is better

Initial ranking idea:

```text
0.22 * discoverySurprise
+ 0.22 * practicalUtility
+ 0.12 * clarity
+ 0.12 * evidenceStrength
+ 0.10 * audienceFit
+ 0.08 * valueSense
+ 0.07 * distinctiveness
+ 0.07 * shareability
- risk penalty
```

These are **starting weights, not scientific constants**. They should be tuned from actual saves, follows, clicks, “知らなかった” reactions, Hub behavior, and explicit human feedback.

Do not include affiliate commission in this score.

### Stage 5 — Similarity / fatigue control

Before selection, compare against recent posts and Hub inventory.

Prevent excessive repetition of:

- same product
- same brand
- same problem solved
- same category
- same hook
- same price angle
- same visual composition
- same “便利” explanation

The account should feel like ongoing discovery, not a sequence of USB accessories or storage boxes merely because they convert.

### Stage 6 — Editorial decision packet

For the best candidates, generate a structured decision packet:

- `whyNow`
- `whyUseful`
- `whatMakesItDifferent`
- `whoFor`
- `whoCanSkip`
- `knownTradeoffs`
- `claimConfidence`
- `sourceSummary`
- `recommendedXAngle`
- `recommendedInstagramAngle`
- `hubCategory`
- `problemTags`

Candidates with weak evidence or no meaningful differentiation should be dropped even when monetizable.

### Stage 7 — Affiliate Route Resolver

Only after editorial selection, resolve monetization routes.

For each available route verify:

- provider account is active
- advertiser/program is approved
- current platform is permitted
- destination is the exact intended product/service
- link-generation method is current
- required disclosure rules are known
- provider/merchant has not expired or disabled the program
- required account/site/SNS registration remains valid
- region/currency/store fit is sensible for the target reader
- link is not stale or malformed

Route selection priority should favor:

1. correct product / service
2. platform and program compliance
3. user accessibility and expected destination quality
4. current availability / terms
5. stable tracking and provider health

Do not choose a materially worse route merely because it pays more commission.

When multiple good purchase routes exist, the Hub should prefer showing useful choices (for example multiple merchants) instead of silently forcing a single high-commission route.

## Affiliate Marketplace Layer

Shared infrastructure should eventually expose a provider-neutral interface such as:

```text
Candidate Product
      ↓
Editorial Selection
      ↓
Affiliate Route Resolver
 ├─ marketplace provider
 ├─ ASP provider
 ├─ direct merchant program
 ├─ network provider
 └─ non-affiliate official route
      ↓
Platform policy check
      ↓
Disclosure / Trust Guard
```

Provider-specific credentials, IDs, API rules and link templates stay in provider adapters/registries.

The convenience account consumes normalized routes only.

## Dedicated Discovery Hub

The Hub is not an optional link page. It is a core product of this brand and should update whenever the account publishes a discovery.

Conceptual role:

**SNS = “こんなのあるんだ”を発生させる場所**

**Hub = あとで探す / 比較する / 最新の購入先を確認する場所**

**Affiliate Layer = 裏側の収益化・経路解決**

### Hub top page

Recommended blocks:

- 今日見つけた便利
- 新着
- 最近よく保存/クリックされた発見
- 暮らしがラクになる
- 仕事がラクになる
- 外出・旅行
- ガジェット
- Web・アプリ
- 無料で使える
- 低価格で便利
- ちょっと変わったもの

### Problem-first navigation

In addition to product categories, allow reverse lookup by annoyance/problem.

Examples:

- 洗濯が面倒
- ケーブルが邪魔
- 忘れ物を減らしたい
- 出張をラクにしたい
- 料理の手間を減らしたい
- PC作業を速くしたい
- 荷物を小さくしたい
- 掃除をラクにしたい

This turns the Hub into a growing **problem → convenience solution database** instead of a generic affiliate catalog.

### Hub item page

Each item should contain, when verified:

- what it is
- the problem it solves
- why it is convenient
- who it suits
- who can skip it
- tradeoffs / limitations
- price / subscription notes with verification timestamp
- alternative products/services
- current approved routes
- last verification timestamp
- status if discontinued/unavailable

Do not present stale prices as current.

## Hub + SNS publish transaction

The user requirement is that the dedicated Hub be updated whenever the account publishes.

Implement this as a staged workflow rather than two unrelated jobs.

Recommended states:

```text
DISCOVERED
→ VERIFIED
→ EDITORIAL_SELECTED
→ ROUTES_RESOLVED
→ HUB_STAGED
→ HUB_READY
→ SNS_PUBLISHING
→ PUBLISHED
```

Rules:

1. Build/validate the Hub item before publishing the SNS post.
2. Do not publish a Hub-dependent affiliate CTA when its Hub destination is unavailable.
3. Publish the SNS post only after the Hub has a valid stable destination.
4. After SNS publication, attach the post IDs/URLs to the Hub record.
5. If SNS publication fails after the Hub is prepared, keep the Hub item unfeatured or mark it pending; do not lose the product record.
6. If one platform succeeds and the other fails, record per-platform state and retry only the failed leg.
7. Never create duplicate Hub entries during recovery/retry.

This should be idempotent and recoverable after workflow interruption.

## X presentation

X should optimize for immediate discovery, not a catalog-card dump.

Typical structure:

1. hook: “こんなのあるんだ” / specific annoyance
2. one-sentence convenience
3. one concrete reason it matters
4. optional who-can-skip line
5. image/card when useful
6. approved direct route or Hub route according to platform/provider rules

Keep the link subordinate to the discovery.

Do not repeat the exact same hook every day.

## Instagram presentation

Instagram should turn the same product object into a native visual explanation.

Default candidate format: 3–5 slide carousel.

Possible slides:

1. **こんなのあるんだ。** + product / use visual
2. **何が便利？**
3. **こういう面倒を減らす**
4. **こんな人向け / いらない人**
5. **詳しくはプロフィールのHub** or approved platform-native route

Reels may be used when the product/service can be demonstrated with rights-cleared media and the demonstration itself materially improves understanding.

Do not make fake hands-on demonstration footage implying first-hand use when the account has not actually tested the product.

## Media policy

Prefer media sources in this order:

1. rights-cleared merchant/affiliate creative supplied for promotion
2. official product media whose promotional reuse is explicitly permitted
3. original neutral explanatory graphics created from verified facts
4. generated background/diagrammatic media that does not misrepresent the physical product

Never generate a fake photorealistic product demonstration and present it as the real product.

Product text/price/specification should be rendered deterministically from verified data rather than trusting image generation to reproduce Japanese text accurately.

## Affiliate Health Monitor

Because this account is affiliate-connected from launch, provider health is a first-class production dependency.

Suggested provider/program states:

- `ACTIVE`
- `DEGRADED`
- `REVERIFY_DUE`
- `APPLICATION_REQUIRED`
- `AUTH_REQUIRED`
- `PROGRAM_PAUSED`
- `DISABLED`

### Every ~6 hours — technical health

Check where permitted/available:

- provider adapter configuration
- required IDs present
- token/credential expiry metadata
- authenticated API availability without performing prohibited traffic
- link-template validity
- Hub route-generation ability

Do not mechanically click conversion/tracking links in a way that creates false affiliate traffic or contaminates analytics.

### Daily — offer and destination health

Check:

- active program/advertiser status when available
- destination/product still exists
- discontinued/unavailable products
- expiring campaigns
- stale route metadata
- broken Hub buttons
- recent provider errors

### Weekly — commercial sync

Refresh/inspect:

- program availability
- current linking method
- eligible products/services
- current creative/feed/API availability
- relevant campaign windows
- provider/merchant route preference only for correctness/availability, not commission ranking

### Monthly — compliance reverification

Re-check current official requirements for each active provider/platform pair, including:

- whether X/Instagram use is still allowed
- account/site registration requirements
- disclosure requirements
- link placement rules
- API/feed changes
- program eligibility changes
- prohibited promotion methods

Record:

- `lastComplianceVerifiedAt`
- source URL/reference
- verifier result
- next review date

If rules are uncertain or changed, set the route/provider to `REVERIFY_DUE` or `DEGRADED` and stop new publishing through that route until resolved.

### Error-triggered checks

Do not wait for scheduled health checks after repeated provider failures.

Examples:

- authentication failure
- repeated link-generation failure
- merchant 404/410
- unexpected redirect/domain change
- missing required disclosure metadata
- API schema change

Escalate automatically to health diagnosis and manual queue where required.

## Route fallback rules

When one affiliate provider fails:

- same exact product + healthy alternative provider → allow safe fallback
- same service + approved official/direct route → allow fallback
- only unrelated “similar” product available → do **not** silently substitute
- no valid route → keep Hub informational and/or hold affiliate CTA according to account policy

Past SNS posts should not be rewritten to point to a different product.

The Hub may update the current purchase route for the **same product** so old social traffic still lands on a maintained destination.

## Hub freshness and lifecycle

Every Hub item should expose internally:

- `lastProductVerifiedAt`
- `lastPriceVerifiedAt`
- `lastAffiliateRouteVerifiedAt`
- `lastComplianceVerifiedAt` (provider-level may be inherited)
- `availability`
- `routeHealth`

If information becomes stale:

- hide exact price first
- mark availability uncertain if needed
- remove dead purchase buttons
- keep the editorial record when useful
- surface a newer/better alternative when verified

## “Better alternative found” behavior

The Hub should remember discoveries over time.

When a new product solves the same problem better:

1. preserve the old product page/history
2. add a verified “current alternative” relationship
3. optionally create a new social post such as “前に紹介した○○、今はこっちも候補”
4. do not claim an upgrade without evidence

This makes the Hub the long-term memory of the account.

## Affiliate provider discovery

Periodically research possible new provider/network/direct-program integrations.

New providers enter as `CANDIDATE_PROVIDER`, never directly as active.

Evaluate:

- relevance to the product universe
- X/Instagram compatibility
- official program availability
- trustworthy linking/reporting method
- API/feed support where useful
- disclosure/compliance requirements
- operational stability

Human/manual steps remain required when applicable for:

- registration
- identity verification
- account/site/SNS review
- terms/contracts
- payout/bank/tax setup
- OAuth/consent
- secret/token creation
- advertiser approval

Never ask the user to paste secrets into chat or commit them to the repository.

## Trust and disclosure

This account may have a high percentage of affiliate-connected posts; that is expected.

Trust must come from transparent operation rather than pretending the links are non-commercial.

Requirements:

- clear affiliate/advertising disclosure according to current platform/provider/legal requirements
- account/profile-level explanation that affiliate links may be used
- post-level disclosure whenever required
- no fake neutrality
- no fake use experience
- no commission-based recommendation ranking
- include tradeoffs/skip guidance when relevant

The reader should be able to think:

**「広告があるのは分かる。でも、このアカウントは本当に便利かどうかで選んでいる。」**

## Growth and learning metrics

Do not optimize only for conversions.

Track separately:

### Discovery value

- saves/bookmarks
- shares/reposts
- comments/replies expressing surprise/discovery
- profile visits
- follows / unfollows
- Hub item opens
- problem/category browsing

### Utility intent

- Hub click-through
- route click-through
- “compare alternative” usage
- later return visits

### Commercial outcome

- provider clicks
- conversions where reporting exists
- revenue
- reversals/cancellations where available

Recommended principle:

**Discovery/Trust decides what deserves audience attention. Revenue measures business outcome after that decision.**

A product that converts strongly but causes unfollows, low trust, complaints, or poor long-term retention should not automatically receive more editorial exposure.

## Dedicated learning loop

Desired loop:

```text
Discover candidates
→ verify + score
→ select
→ resolve affiliate routes
→ stage/update Hub
→ publish X/Instagram
→ measure discovery + utility + commercial signals
→ learn category/problem/format preferences
→ discover again
```

Learning may tune:

- which problems/categories generate follows/saves
- which visual explanation style works
- optimal post times
- how much detail to include
- Hub navigation
- CTA wording

Learning must not tune:

- “choose the highest commission item”
- deceptive urgency
- unsupported claims
- prohibited promotion methods

## Initial content mix hypothesis

This account can have a higher commercial density than the other planned accounts.

A reasonable starting experiment is:

- 50–70% discoveries with a valid affiliate route
- 30–50% non-affiliate/free/comparison/“you may not need this” discoveries

These are starting hypotheses, not fixed requirements.

The account should remain worth following even for a user who does not buy anything this week.

## Current operational state

At the time this recovery brief is created:

- the account pair does not yet exist as live configured accounts
- no live X or Instagram account has been enabled by this document
- no Amazon/Rakuten/A8/ValueCommerce/general-commerce credentials have been added by this document
- no affiliate application has been submitted by this document
- no Hub has been deployed by this document
- no product has been promoted by this document
- no affiliate link has been generated or clicked by this document

Existing music-plugin affiliate infrastructure must not be mistaken for an already-connected general-commerce provider stack.

## Future implementation order

When implementation begins, prefer this order:

1. create account-specific config objects for the X + Instagram pair, disabled/approval-first
2. create `General Commerce Registry` separate from music-plugin program entries
3. create normalized `Product` + `Offer/AffiliateRoute` models
4. implement Convenience Discovery Score + hard filters + duplicate/fatigue control
5. implement provider-neutral Affiliate Route Resolver
6. implement Affiliate Health Monitor and provider states
7. implement dedicated Discovery Hub data model and static/serverless publishing path
8. implement idempotent Hub-first publish transaction
9. implement X discovery-card rendering
10. implement Instagram carousel rendering
11. implement platform/provider compliance gate + disclosure
12. add metrics for Hub opens/clicks/routes + social discovery signals
13. add periodic provider/program compliance reverification
14. add provider discovery/manual setup queue
15. only after controlled dry-run and approval tests, connect real provider credentials and enable live publishing

## Recovery order for a future session

When returning to this account after working on other accounts, inspect in this order:

1. `docs/CONVENIENCE_AFFILIATE_ACCOUNT_RECOVERY.md` — this source of truth
2. future account config entries for the X/Instagram pair
3. future general-commerce affiliate registry/provider configuration
4. shared `docs/AFFILIATE_TRUST_POLICY.md`
5. Affiliate Health Monitor status/report
6. Hub build/deploy status and product inventory
7. current provider manual setup queue
8. posting history / social metrics / Hub analytics / affiliate reporting

The design should remain recoverable from repository state without depending on the original planning conversation.
