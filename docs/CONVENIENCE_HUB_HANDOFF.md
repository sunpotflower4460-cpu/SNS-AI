# Convenience Discovery Hub handoff

This document is the durable bridge between SNS-AI and the separate convenience-discovery Hub repository.

## Hub repository

`sunpotflower4460-cpu/SNS-HUB`

The public brand name may change later. The repository and architecture boundary should remain stable unless deliberately migrated.

## Source-of-truth relationship

The account/editorial source of truth remains:

`docs/CONVENIENCE_AFFILIATE_ACCOUNT_RECOVERY.md`

SNS-HUB owns implementation details for the public web Hub.

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

```text
SNS-AI
  discover → verify → score → select → resolve routes → stage/update Hub

SNS-HUB
  validate → build/deploy → expose expected contentVersion → HUB_READY

SNS-AI
  publish X/Instagram → attach social backlinks to Hub record
```

## Implemented Git-backed runtime

`src/hub/convenience-hub.mjs` uses a dedicated Hub repository credential and never falls back to generic SNS-AI `GITHUB_TOKEN`.

`npm run hub:stage -- --file <canonical-product.json> --wait`:

1. reads/merges the canonical Hub product;
2. writes only when content changed;
3. computes the exact expected `contentVersion` from that Git commit;
4. optionally waits until the deployed health endpoints expose the exact version;
5. returns a versioned `hub` envelope for the social publish payload.

The publish envelope is:

```json
{
  "required": true,
  "integration": "convenience-discovery-v1",
  "productId": "stable-product-id",
  "expectedContentVersion": "20-char-sha256-prefix"
}
```

`src/publish.mjs` wraps the unchanged legacy posting core. Unrelated accounts immediately use the existing core path. Hub-dependent live publishing requires a durable `slotId`, verifies HUB_READY before a new provider mutation, and stores the Hub envelope in the durable claim. If the provider succeeds but Hub backlink reconciliation fails, the command reports `HUB_BACKLINK_PENDING`; replay uses the published durable claim and retries the Hub leg without publishing the social post again.

## Required external configuration later

Do not place these values in the repository:

- `CONVENIENCE_HUB_GITHUB_TOKEN` — narrowly scoped SNS-HUB write credential
- `CONVENIENCE_HUB_REPOSITORY` — `sunpotflower4460-cpu/SNS-HUB`
- `CONVENIENCE_HUB_PUBLIC_URL` — deployed HTTPS origin
- `CONVENIENCE_HUB_BRANCH` — normally `main`

No live convenience account is created or enabled by this document or adapter.

## Canonical model rule

Keep **Product identity** separate from **Offer/AffiliateRoute identity**. One product can have Amazon/Rakuten/ASP/direct routes without becoming multiple editorial products. A failed route may fall back only to another healthy route for the same product. Never silently replace it with a merely similar product.

## Hub lifecycle rule

Old public product URLs remain stable. If a product becomes unavailable/discontinued, preserve the page/history, remove dead routes, avoid stale exact pricing, show a verified current alternative when appropriate, and never rewrite old social traffic to an unrelated product.

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

All update/retry operations are idempotent.

## Secrets

Never commit or paste Hub write credentials, provider credentials, deploy tokens, or signing secrets into chat/repositories. Use narrowly scoped external secret storage during final setup.
