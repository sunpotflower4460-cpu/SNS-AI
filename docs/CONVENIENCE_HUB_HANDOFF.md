# Convenience Discovery Hub handoff

This document is the durable bridge between SNS-AI and the future separate convenience-discovery Hub repository.

## Provisional separate repository

`sunpotflower4460-cpu/Convenience-Discovery-Hub`

The repository/public brand name may change later. The architecture boundary should not.

## Source-of-truth relationship

The account/editorial source of truth remains:

`docs/CONVENIENCE_AFFILIATE_ACCOUNT_RECOVERY.md`

The future Hub repository owns implementation details for the public web Hub.

## Responsibility boundary

### SNS-AI owns

- product discovery
- verification and evidence
- Convenience Discovery Score
- editorial selection
- duplicate/fatigue control
- affiliate provider adapters and registry
- Affiliate Route Resolver
- provider/compliance health
- X / Instagram generation and publishing
- learning from social/commercial metrics

### Hub owns

- stable public product URLs
- product/category/problem pages
- search/filtering
- problem-first navigation
- current normalized purchase/use routes supplied by SNS-AI
- visible freshness information
- alternatives/related items
- Hub analytics
- machine-readable readiness/content version

## Critical invariant

**Never publish a Hub-dependent X/Instagram CTA until the Hub confirms the expected content version is publicly ready.**

Desired high-level flow:

```text
SNS-AI
  discover
  → verify
  → score
  → select
  → resolve routes
  → stage/update Hub

Hub
  validate
  → build/deploy
  → expose expected contentVersion
  → HUB_READY

SNS-AI
  publish X/Instagram
  → attach social backlinks to Hub record
```

## Recommended MVP implementation

Start Git-backed and audit-friendly before introducing a database/API.

Suggested Hub content layout:

```text
data/products/<productId>.json
schemas/product.schema.json
data/categories.json
data/problem-tags.json
```

The deployed Hub should expose a machine-readable endpoint such as:

`GET /_health/content-version`

SNS-AI waits until it sees the version corresponding to the staged product update before changing state to `HUB_READY`.

Only migrate to a signed ingest API + database if Git-backed deploy latency/update volume becomes a demonstrated bottleneck.

## Canonical model rule

Keep **Product identity** separate from **Offer/AffiliateRoute identity**.

One product can have Amazon/Rakuten/ASP/direct routes without becoming multiple editorial products.

A failed route may fall back only to another healthy route for the same product. Never silently replace it with a merely similar product.

## Hub lifecycle rule

Old public product URLs should remain stable.

If a product becomes unavailable/discontinued:

- preserve the page/history
- remove or disable dead routes
- avoid stale exact pricing
- show a verified current alternative when appropriate
- do not rewrite old social traffic to an unrelated product

## Integration states

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

All update/retry operations must be idempotent.

## Secrets

Never commit or paste Hub write credentials, provider credentials, deploy tokens, or signing secrets into chat/repositories.

Use narrowly scoped external secret storage during final setup.

## New-project handoff pack

The prepared handoff pack contains:

1. `00_START_HERE.md`
2. `01_PRODUCT_AND_UX_SPEC.md`
3. `02_ARCHITECTURE.md`
4. `03_DATA_CONTRACT.md`
5. `04_SNS_AI_INTEGRATION.md`
6. `05_IMPLEMENTATION_PLAN.md`
7. `06_SECURITY_AND_OPERATIONS.md`
8. `07_ACCEPTANCE_TESTS.md`
9. `08_NEW_CHAT_START_PROMPT.md`
10. `09_HANDOFF_SUMMARY_FOR_SNS_AI.md`

Copy these into the root/docs of the new Hub repository at bootstrap so that a separate project chat can reconstruct the implementation without the original conversation.

## Future recovery order

When the Hub repository exists, recover in this order:

1. this document
2. `docs/CONVENIENCE_AFFILIATE_ACCOUNT_RECOVERY.md`
3. Hub repository `00_START_HERE.md`
4. Hub architecture/data-contract/integration docs
5. Hub build/deploy/health state
6. SNS-AI Affiliate Health Monitor / route status
7. social + Hub + commercial metrics

The system should remain recoverable from repository state without depending on the original planning chat.
