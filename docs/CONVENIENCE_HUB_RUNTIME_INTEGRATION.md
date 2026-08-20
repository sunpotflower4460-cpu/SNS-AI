# Convenience Hub runtime integration

SNS-AI can optionally make a convenience-discovery Hub update part of the same durable publishing transaction.

## Activation

The integration is dormant unless a publish payload contains either:

- `hubProduct`: a complete canonical product object ready to stage, or
- `hub.required: true` with `integration: convenience-discovery-v1`, `productId`, and `expectedContentVersion`.

Unrelated accounts and ordinary payloads continue through the existing publishing core unchanged.

## Required external configuration

Keep these outside the repository:

- `CONVENIENCE_HUB_GITHUB_TOKEN` — narrowly scoped write credential for the Hub repository; there is intentionally no fallback to the generic SNS-AI GitHub credential.
- Repository variable `CONVENIENCE_HUB_REPOSITORY` — normally `sunpotflower4460-cpu/SNS-HUB` once activation is intended.
- Repository variable `CONVENIENCE_HUB_PUBLIC_URL` — deployed HTTPS origin only.
- Repository variable `CONVENIENCE_HUB_BRANCH` — defaults to `main` in code when omitted.

## Transaction ordering

For a new `hubProduct`:

```text
validate canonical product
→ idempotently stage it in SNS-HUB
→ compute exact expected contentVersion from that commit snapshot
→ wait until deployed health endpoints expose that exact version/product as ready
→ persist Hub requirement in durable slot claim
→ call the existing SNS provider publishing core
→ confirm durable `published` claim
→ attach X/Instagram social backlink to Hub record
```

The provider post is never created before `HUB_READY`.

If the provider succeeds but the durable published claim cannot be confirmed, SNS-AI surfaces `HUB_DURABLE_PENDING` and does not mark the Hub product published. If only the Hub backlink update fails, it surfaces `HUB_BACKLINK_PENDING`. Replaying the same durable slot reconciles unfinished bookkeeping without intentionally creating the provider post again.

## Dry-run

Dry-run validates `hubProduct` locally but does not write SNS-HUB, wait for deploy, or publish. The full canonical product is stripped before entering the normal publishing core/history boundary.

## Security / integrity

- Hub inputs reject credential-looking fields and high-confidence secret material.
- Hub URLs must be credential-free HTTPS.
- Hub health checks are restricted to the configured public origin.
- Affiliate redirect/destination URLs are not probed as part of Hub readiness.
- Stable product IDs/slugs and historical social backlinks are preserved during idempotent updates.
- GitHub write conflicts are re-read/re-merged rather than blindly overwritten.
