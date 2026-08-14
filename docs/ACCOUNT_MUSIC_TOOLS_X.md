# music-tools-x rollout

`music-tools-x` is the first production-oriented account profile for SNS-AI. It is intentionally committed in a non-posting state until external credentials and billing are ready.

## Account mission

Japanese-language music-production discovery account focused on:

- new VST/AU plugins and major updates
- free plugins and time-limited giveaways
- plugin sales and bundles when the current price/deadline can be verified
- EQ, compression, saturation, reverb, delay, synths, instruments, samplers and vocal/guitar/bass tools
- mixing/mastering workflow tools
- DAWs and production workflow improvements
- AI music/audio tools
- physical modelling, modular and experimental audio technology
- useful tools trending overseas before they become saturated in Japanese-language feeds
- practical comparisons, alternatives and “who is this for?” recommendations

The account should add decision value instead of reposting product announcements. It must not invent first-hand product experience, affiliations, pricing, dates or results.

## Research policy

`webSearch` and `trendIntelligence` are enabled for this account. Time-sensitive claims should prefer current primary sources in this order:

1. official product/manufacturer page
2. official news/release notes/documentation
3. official social account or official GitHub repository
4. credible specialist publication when primary information is unavailable

If only secondary evidence is available, wording should remain appropriately qualified. Price, discount, availability and deadline claims should be omitted when they cannot be verified at generation time.

## Initial publishing policy

The account is configured conservatively:

- `enabled: false`
- `mode: approval`
- text-only media strategy (`none`)
- up to 2 posts/day
- at least 6 hours between posts
- at most 1 link and 2 hashtags per post
- nominal slots: 09:00 and 20:00 JST
- adaptive scheduling is restricted to the explicitly configured candidate times

Keeping media disabled initially avoids requiring X OAuth2 media setup. Once the text-only path is stable, image publishing can be enabled separately without changing the account identity or research policy.

## External setup still required

Do not put any secret value in this repository or in an Issue/PR comment.

### 1. X developer credentials

For initial text-only posting, prepare OAuth1 user-context credentials for the real X account:

- consumer key
- consumer secret
- access token
- access token secret

The credential entry key must be `music-tools-x` in `SOCIAL_CREDENTIALS_JSON`.

### 2. OpenAI API

Prepare an OpenAI API key with API billing/credits available. This account uses the API for post generation, Web Search, Trend Intelligence and moderation.

### 3. GitHub Actions Secrets

Add these directly in Repository Settings → Secrets and variables → Actions:

- `OPENAI_API_KEY`
- `SOCIAL_CREDENTIALS_JSON`

`X_OAUTH2_STATE_KEY` is not required while this account remains text-only. Add it later if X image/video publishing is enabled.

## Controlled activation sequence

After the external setup above is complete:

1. change only `music-tools-x.enabled` to `true`; keep `mode: approval`
2. run **SNS Live Preflight** for `music-tools-x`
3. run **SNS Autopilot** manually with `force=true` and `dry_run=true`
4. inspect the generated post and cited research sources
5. approve exactly one controlled real post
6. verify `data/history.jsonl`, provider post ID and subsequent metrics collection
7. review several approval posts for tone, factuality and topic balance
8. only then change `mode` to `auto`

## Later optional expansion

After text-only operation is stable:

- enable image generation or a trusted media library
- add X OAuth2 media scopes and `X_OAUTH2_STATE_KEY`
- introduce affiliate links only after a disclosure policy and approved domains are configured
- tune topic mix and posting times using real metrics and explicit human feedback

The current configuration deliberately does not enable affiliate claims, paid-placement wording, or media publishing before those external requirements are known.
