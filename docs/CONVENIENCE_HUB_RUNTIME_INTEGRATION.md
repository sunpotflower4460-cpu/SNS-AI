# Convenience Hub runtime integration

This adapter is intentionally opt-in and isolated from unrelated SNS-AI accounts.

## Dedicated environment

Live Hub operations require all of:

- `CONVENIENCE_HUB_REPOSITORY` — explicit `owner/repo`
- `CONVENIENCE_HUB_GITHUB_TOKEN` — narrowly scoped credential for the Hub repository
- `CONVENIENCE_HUB_PUBLIC_URL` — deployed Hub HTTPS origin
- `CONVENIENCE_HUB_BRANCH` — optional; defaults to `main`

The adapter deliberately does **not** fall back to generic `GITHUB_TOKEN` / `GH_TOKEN` so an approval/workflow credential cannot silently become a cross-repository Hub writer.

## Stage contract

`stageHubProduct(product)` requires canonical schema version 1 and `publication.status=ready`.

It:

1. reads the existing canonical record when present;
2. enforces stable `productId` / public slug;
3. keeps historical social backlinks;
4. treats the new route list as authoritative current state;
5. does not downgrade an already-published item back to ready;
6. writes the canonical JSON with GitHub Contents API only when content changed;
7. computes the exact expected Hub `contentVersion` from the returned commit snapshot.

## HUB_READY contract

`getHubReadiness` / `assertHubReady` only read:

- `/_health/content-version`
- `/_health/product/<productId>`

They never probe `/go/...` or an affiliate destination. Readiness requires the exact expected `contentVersion`, matching product ID, `publishReady=true`, `publiclyReachable=true`, and a stable product URL on the configured Hub origin.

## Social backlink contract

`attachHubSocialBacklink` is idempotent per `platform + postId`. The first successful social backlink changes a `ready` item to `published` and records `firstPublishedAt`; X and Instagram remain independent so a failed leg can be retried later without duplicating the successful platform.

Provider publication must remain the source of truth. When this adapter is connected to `publish.mjs`, a Hub backlink bookkeeping failure after provider success must never cause the provider post to be repeated; durable replay should retry only Hub reconciliation.
