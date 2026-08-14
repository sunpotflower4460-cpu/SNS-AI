# music-tools-x rollout

`music-tools-x` is the first production-oriented account profile for SNS-AI. It is intentionally committed in a non-posting state until external credentials and billing are ready.

## Account concept

**海外のまだ知られていない良いプラグインを発掘して、買う価値まで日本語で判断する。**

Brand tagline:

**まだ知られていない音を、先に見つける。**

This positioning belongs only to `music-tools-x`. Shared SNS-AI infrastructure may provide research, analytics, safety and learning to other accounts, but other accounts do not inherit this concept, persona or editorial voice.

## Primary persona

The core reader is:

**有名プラグインには少し飽きている。でも海外まで毎日掘る時間はないDTMer。**

Typical context:

- roughly 2–7 years of music-production experience
- already knows or owns several mainstream plugins
- keeps making music around work and daily life, so research time is limited
- does not continuously monitor KVR, overseas communities, GitHub and small developers
- likes discovering new tools but dislikes buying another near-duplicate that ends up unused
- wants unusual new technology and small-developer discoveries without testing everything personally

The main follow reason is simple: **this account does the digging, selection and first-pass purchase judgment that the reader does not have time to do.**

Secondary audiences can include beginners who need plain-language explanations, advanced plugin enthusiasts who want obscure discoveries, and producers interested in AI/workflow tools. Each post should still choose one primary audience instead of trying to address everyone at once.

## Account mission

Japanese-language music-production discovery account focused on:

- overseas tools that are still under-covered in Japanese-language feeds
- small or emerging developers with genuinely interesting products
- unusual or technically distinctive VST/AU/CLAP plugins
- new plugins and major updates
- free plugins and time-limited giveaways when genuinely useful or interesting
- practical comparisons, alternatives and “who is this for?” recommendations
- “buy or skip?” decision support, including cases where an existing tool is already enough
- AI music/audio tools
- physical modelling, modular and experimental audio technology
- EQ, compression, saturation, reverb, delay, synths, instruments, samplers and vocal/guitar/bass tools
- mixing/mastering workflow tools
- DAWs and production workflow improvements
- plugin sales and bundles only when the product itself is worth editorial attention and the current price/deadline can be verified

The account should add **discovery + selection + comparison + decision value** instead of reposting product announcements. It must not invent first-hand product experience, affiliations, pricing, dates or results.

## Editorial promise

- find good tools the reader probably has not seen yet
- explain why the product is unusual or useful, not merely that it exists
- say who it is for and, where useful, who can safely skip it
- explicitly say when an existing/free/cheaper alternative is sufficient
- never treat “overseas” as proof of quality by itself
- never let affiliate availability or commission rate determine recommendation ranking
- do not become a generic sale-alert feed

## Research policy

`webSearch` and `trendIntelligence` are enabled for this account. Discovery may use overseas specialist communities and forums, but time-sensitive factual claims should return to current primary sources in this order:

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
- connect approved affiliate providers behind the existing Affiliate Trust Guard
- tune discovery mix and posting times using follow conversion, bookmarks, replies, profile clicks and explicit human feedback

The current configuration deliberately does not enable affiliate claims, paid-placement wording, media publishing or engagement automation before those external requirements are known.
