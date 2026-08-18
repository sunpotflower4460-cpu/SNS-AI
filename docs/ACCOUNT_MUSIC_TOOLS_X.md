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

The account is configured conservatively only for the **first controlled launch**:

- `enabled: false`
- `mode: approval`
- text-only media strategy (`none`)
- up to 2 posts/day
- at least 6 hours between posts
- at most 1 link and 2 hashtags per post
- nominal slots: 09:00 and 20:00 JST
- adaptive scheduling is restricted to the explicitly configured candidate times

Keeping media disabled initially avoids requiring X OAuth2 **media** setup. It does not mean OAuth2 is unnecessary for inbound engagement: autonomous mentions/DM handling uses OAuth2 user-context scopes separately from the OAuth1 text-posting path.

The intended steady state is **`mode: auto` with exception-based human escalation**, not ongoing per-post approval.

## External setup still required

Do not put any secret value in this repository, an Issue/PR comment, or ordinary chat text.

### 1. X developer credentials — posting

For initial text-only publishing, prepare OAuth1 user-context credentials for the real X account:

- consumer key
- consumer secret
- access token
- access token secret

The credential entry key must be `music-tools-x` in `SOCIAL_CREDENTIALS_JSON`.

### 2. X OAuth2 — autonomous replies / DMs

To enable the Engagement Autopilot as part of the initial long-running setup, complete OAuth2 user authorization for the same X account.

The authorization must cover the read/write functions actually enabled. For the current design this includes the scopes needed to:

- read mentions: `tweet.read`, `users.read`
- send public replies: `tweet.write` plus the user-context read scopes required by X
- read DMs: `dm.read`, `tweet.read`, `users.read`
- send one-to-one DM replies: `dm.write`, `tweet.read`, `users.read`
- keep the authorization alive without repeated manual consent: `offline.access`

Store the OAuth2 client/refresh/access fields only inside the `music-tools-x` credential object in `SOCIAL_CREDENTIALS_JSON` and use `X_OAUTH2_STATE_KEY` for encrypted rotating OAuth2 state.

If posting credentials are ready but these engagement scopes are not, normal publishing can still be tested while `SNS Engagement Autopilot` stays in `waiting_for_engagement_credentials`; it must not guess missing permissions or send anything.

### 3. OpenAI API

Prepare an OpenAI API key with API billing/credits available. This account uses the API for post generation, Web Search, Trend Intelligence, moderation, and eligible inbound-response classification/drafting.

### 4. GitHub Actions Secrets

Add these directly in Repository Settings → Secrets and variables → Actions:

- `OPENAI_API_KEY`
- `SOCIAL_CREDENTIALS_JSON`
- `X_OAUTH2_STATE_KEY` when autonomous X engagement is enabled

`X_OAUTH2_STATE_KEY` is also used later for OAuth2 media publishing. Losing it requires OAuth2 reauthorization/bootstrap because saved rotating token state can no longer be decrypted.

## Controlled activation sequence

After the external setup above is complete:

1. change only `music-tools-x.enabled` to `true`; keep `mode: approval` for the first controlled publish
2. from ChatGPT/GitHub ChatOps, run `[preflight] music-tools-x`
3. run `[dry-run] music-tools-x` and inspect the generated post/research result
4. if engagement OAuth2 is configured, run `[engagement-dry-run] music-tools-x`
5. approve exactly **one** controlled real post by adding the `approved` label to its approval Issue
6. verify `data/history.jsonl`, provider post ID, and subsequent metrics collection
7. if that controlled publish and readiness checks are clean, change `mode` to `auto`
8. leave routine posting and eligible inbound engagement unattended; return to approval only after a safety brake, credential change, major account-policy change, or another explicit exception

The goal is not to keep clicking approval buttons. The one controlled publish is a launch proof; steady-state operation is autonomous.

## Engagement steady state

Once engagement credentials are ready and the account is enabled:

- X mentions and eligible inbound DMs are polled automatically
- routine high-confidence interactions are answered after a bounded human-like delay
- opt-outs, duplicate responses, unsolicited outreach, and daily caps are enforced before sending
- difficult/high-stakes/low-confidence cases create `[engagement-human]` Issues instead of guessing
- the connected ChatGPT condition-watch surfaces only those unresolved exception cases back into chat
- private DM bodies are not copied into this public repository

## Later optional expansion

After the initial text-only path is stable:

- enable image generation or a trusted media library
- add X OAuth2 `media.write` and the media-specific setup if images/video are enabled
- connect approved affiliate providers behind the existing Affiliate Trust Guard
- tune discovery mix and posting times using follow conversion, bookmarks, replies, profile clicks and explicit human feedback

Affiliate claims, paid-placement wording, and media publishing remain separately gated until their own external requirements are satisfied. Engagement automation is separately allowlisted and still cannot run while `music-tools-x` itself remains disabled.
