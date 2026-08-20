# Convenience Discovery Hub handoff

This document is the durable bridge between SNS-AI and the separate convenience-discovery Hub repository.

## Hub repository

`sunpotflower4460-cpu/SNS-HUB`

SNS-AI remains the editorial/discovery source of truth; SNS-HUB owns the public browse/search/product experience.

## Source-of-truth relationship

The account/editorial source of truth remains:

`docs/CONVENIENCE_AFFILIATE_ACCOUNT_RECOVERY.md`

Runtime details live in:

`docs/CONVENIENCE_HUB_RUNTIME_INTEGRATION.md`

## Responsibility boundary

### SNS-AI owns

- product discovery and evidence verification
- Convenience Discovery Score and editorial selection
- affiliate provider adapters / route resolution / trust policy
- canonical Product object supplied to Hub
- Hub staging and exact content-version expectation
- X / Instagram generation and publishing
- social backlink reconciliation
- learning from social/commercial metrics

### SNS-HUB owns

- stable public product URLs
- product/category/problem pages
- search/filtering/problem-first navigation
- current normalized purchase/use routes supplied by SNS-AI
- visible freshness information
- alternatives/related items
- Hub analytics
- machine-readable readiness/content version

## Critical invariant

**Never publish a Hub-dependent X/Instagram CTA until SNS-HUB confirms that the exact expected content version and product are publicly ready.**

Runtime flow:

```text
SNS-AI
  discover / verify / score / select
  → validate canonical Product
  → stage Product to SNS-HUB Git repository
  → compute expected contentVersion from staged commit snapshot

SNS-HUB deploy
  validate / build / deploy
  → /_health/content-version
  → /_health/product/:productId
  → exact HUB_READY

SNS-AI
  → durable Hub requirement
  → X / Instagram provider publish
  → durable published barrier
  → Hub social backlink
```

All update/retry operations are idempotent. A provider-success bookkeeping failure must reconcile the durable slot rather than blindly republish.

## Product identity rule

Keep **Product identity** separate from **Offer/AffiliateRoute identity**.

One product can have Amazon/Rakuten/ASP/direct routes without becoming multiple editorial products. A failed route may fall back only to another healthy route for the same product. Never silently replace it with a merely similar product.

## Lifecycle rule

Old public product URLs should remain stable. If a product becomes unavailable/discontinued, preserve the page/history, disable dead routes, avoid stale exact pricing, and surface a verified alternative where appropriate rather than rewriting old social traffic to another product.

## Secrets

Never commit or paste Hub write credentials, provider credentials, deploy tokens, or signing secrets into chat/repositories.

SNS-AI uses a dedicated `CONVENIENCE_HUB_GITHUB_TOKEN`; there is intentionally no fallback to its general GitHub token. The Hub repository/public URL/branch are configuration variables, not hard-coded live activation.

## Remaining external activation gates

Repository-side implementation can be complete while live activation remains off. Before a convenience account is enabled:

1. deploy SNS-HUB to an HTTPS server-capable Next.js host;
2. verify its health endpoints expose the Git-backed content version;
3. create the narrowly scoped SNS-HUB write credential;
4. set SNS-AI Hub repository/public URL/branch variables;
5. define final convenience X/Instagram account IDs and discovery→canonical-product mapping;
6. run a controlled non-live/sandbox rehearsal before the first real Hub-dependent post.

These are external deployment/credential/account facts; SNS-AI must not pretend to have completed them from repository code alone.
