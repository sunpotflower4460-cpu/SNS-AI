# music-tools-x recovery brief

This file is the durable recovery index for the `music-tools-x` account. Its purpose is to make the account recoverable from the repository even if the original planning conversation is unavailable.

## Scope boundary

Everything in this document is **account-specific to `music-tools-x`** unless explicitly described as shared infrastructure.

Do not copy this concept, persona, editorial voice, or discovery priorities into future accounts by default. Future accounts may share SNS-AI research, safety, analytics, learning, affiliate, and engagement infrastructure while keeping their own concept and persona.

## One-sentence concept

**海外のまだ知られていない良いプラグインを発掘して、買う価値まで日本語で判断する。**

Brand tagline:

**まだ知られていない音を、先に見つける。**

The account is not primarily a sale-alert account, generic plugin-news account, or manufacturer repost account. Its differentiator is:

**discovery + selection + comparison + decision support.**

## Primary persona

Core reader:

**有名プラグインには少し飽きている。でも海外まで毎日掘る時間はないDTMer。**

Typical profile:

- roughly 2–7 years of music-production experience
- already knows or owns several mainstream plugins
- produces music around work and daily life, so research time is limited
- does not continuously monitor KVR, overseas communities, GitHub, developer blogs, and small developers
- likes finding unusual tools and new audio technology
- dislikes buying another near-duplicate that ends up unused
- wants a fast answer to “what is different, who is this for, and do I actually need it?”

The main follow reason is:

**“自分で海外まで掘らなくても、面白いものだけ見つかり、自分に必要かまで分かる。”**

Secondary readers may include beginners needing plain-language explanations, advanced plugin enthusiasts looking for obscure discoveries, and producers interested in AI/workflow tools. Each post should still write primarily for one reader rather than trying to address everyone at once.

## Editorial personality

The voice should feel like **a curious plugin explorer / curator who enjoys digging up unusual tools**, not a faceless sale feed and not a fake reviewer.

Useful tone examples:

- 「これ、ちょっと面白いの見つけた」
- 「日本語情報はまだ少ないけど、仕組みがかなり変わってる」
- 「これは人を選びそう」
- 「○○を持っているなら、急いで買わなくてもよさそう」

Never fabricate first-hand usage, listening impressions, manufacturer relationships, gifts, sponsorships, prices, deadlines, or results.

## Discovery priorities

Prefer, in roughly this order:

1. strong overseas tools still under-covered in Japanese-language feeds
2. small/emerging developers with genuinely distinctive products
3. technically unusual VST/AU/CLAP plugins
4. new audio technology, physical modelling, modular, experimental audio, AI audio, and workflow innovation
5. useful new plugins and meaningful major updates
6. “buy or skip?” comparisons, alternatives, and replacement decisions
7. free tools and limited giveaways when they are actually interesting/useful
8. mainstream releases when the update itself has real editorial value
9. sales/bundles only when the product is independently worth covering

“Overseas” is a discovery source, not proof of quality.

## Editorial promise

Every useful recommendation should help with one or more of:

- what is actually new or unusual
- who it suits
- who can skip it
- how it differs from familiar alternatives
- whether an existing/free/cheaper tool is already enough
- whether the current release/update materially changes the purchase decision

A recommendation can explicitly conclude **“買わなくていい”**. This is a feature, not a failure.

Do not allow affiliate availability or commission rate to influence recommendation ranking.

## Growth strategy

The account should optimize for **follow-worthy usefulness**, not raw impressions or likes alone.

When the X analytics path is available, prioritize metrics such as:

- follows
- unfollows
- user/profile clicks
- bookmarks
- replies
- reposts/shares
- URL clicks
- impressions as denominator/exposure

Useful derived concepts for future implementation:

- `Follow Yield = follows / impressions`
- `Profile-to-Follow = follows / profile visits`
- `Save Value = bookmarks / impressions`
- `Conversation Value = replies / impressions`
- `Follow Damage = unfollows / impressions`

A smaller post that produces many follows/bookmarks may be strategically better than a high-impression post that creates little lasting interest.

### Content formats with strong strategic fit

- overseas discovery / “日本語情報ほぼなし”
- “買う？スルー？”
- existing-owner decision: “○○持っている人は必要？”
- unusual/free tool discovery
- major-update delta: “旧版から何が変わった？”
- practical comparison / alternative / free alternative
- compatibility and workflow decision posts
- recurring “Plugin Radar” / weekly discoveries
- short visual/video explainers once media operation is stable

Do not turn the account into a repetitive fixed-template feed; recurring series may have stable names while hooks, structures, and topics should vary.

## Conversation / DM strategy

Replies and DMs are not only customer support; they are **demand research**.

Desired future loop:

inbound reply/DM → classify question → safe response or approval queue → aggregate repeated questions → feed recurring needs into future content candidates.

Examples:

- repeated “Cubaseでも動く？” → compatibility content
- repeated “無料のリバーブありますか？” → free-alternative feature
- repeated confusion about upgrade value → “買う？スルー？” post

Safety boundary:

- inbound-first only
- no cold keyword auto-replies to unrelated users
- no unsolicited bulk DMs
- no auto-follow / auto-unfollow growth automation
- no artificial cross-account amplification
- start with approval-mode replies; only low-risk FAQ classes may become fully automatic after validation

See `config/engagement-policy.json` and `docs/MANUAL_EXTERNAL_SETUP_QUEUE.md` for current controls and manual permissions.

## Affiliate / monetization strategy

Business model is compatible with affiliate links, but monetization comes **after independent editorial selection**.

Required order:

research/discovery → independent recommendation decision → affiliate registry lookup → disclosure/trust guard → publish → track utility/trust/revenue separately.

Operating principle:

**Trust > Utility > Revenue**

A high-revenue affiliate post that damages later organic engagement or trust is not considered a successful post.

The repository already contains:

- `config/affiliate-programs.json` — researched program registry
- `docs/AFFILIATE_TRUST_POLICY.md` — trust/selection/disclosure policy
- `docs/MANUAL_EXTERNAL_SETUP_QUEUE.md` — applications, OAuth, payout/tax, webhook and secret tasks that require a person

Affiliate publishing remains disabled until actual programs are approved and current terms are reverified.

## Current operational state

At the time this recovery brief was created:

- `music-tools-x.enabled = false`
- mode is `approval`
- live posting has not been activated
- media strategy is text-only / `none`
- affiliate publishing is disabled
- engagement automation is disabled
- no real affiliate links or affiliate secrets are stored in the repository
- no real DMs/replies should be sent by the dormant adapters
- initial posting cap is up to 2 posts/day with at least 6 hours between posts

The repository configuration is the final authority if these values later change.

## Manual gates to remember later

Do not ask the user to paste secrets into chat or commit them to GitHub.

Manual/external actions include:

- X developer/account credentials and OAuth consent/scopes
- OpenAI API key/billing
- Instagram professional account / Meta app permissions / webhooks when Instagram engagement is used
- affiliate applications and terms acceptance
- affiliate payout/bank/tax profile
- provider IDs/tokens created after approval
- partnership contracts or other obligations

The authoritative checklist is `docs/MANUAL_EXTERNAL_SETUP_QUEUE.md`.

## Next high-value growth implementations

These were identified but should not be confused with already-completed features:

1. **Growth Analytics** — store/learn follows, unfollows, profile visits, bookmarks and related conversion metrics when API access permits.
2. **Follow Yield ranking** — teach strategy learning that follow conversion can outrank raw impressions.
3. **Opportunity Score** — prioritize Japanese under-coverage + novelty + usefulness + reader fit, not trend popularity alone.
4. **Question Mining** — aggregate repeated inbound reply/DM questions into content opportunities.
5. **Plugin Radar / decision metadata** — optionally maintain structured “who is it for / who can skip / alternatives / novelty” records.
6. **Media expansion** — short video/image explainers only after text operation is stable and rights/API requirements are satisfied.
7. **Webhook receiver** — needed for robust real-time Instagram engagement; GitHub Actions alone is not a persistent webhook server.

Do not implement these by weakening platform rules, trust guards, or factual verification.

## Recovery order for a future session

When returning to this account after working on other accounts, inspect these files in this order:

1. `docs/MUSIC_TOOLS_X_RECOVERY.md` — this recovery index
2. `config/accounts.json` → `accounts.music-tools-x` — active machine-readable concept/persona/rules
3. `docs/ACCOUNT_MUSIC_TOOLS_X.md` — rollout and editorial detail
4. `config/affiliate-programs.json` and `docs/AFFILIATE_TRUST_POLICY.md` — monetization state
5. `config/engagement-policy.json` — reply/DM safety state
6. `docs/MANUAL_EXTERNAL_SETUP_QUEUE.md` — remaining human-only steps
7. current history/metrics/learning data — actual post performance once the account is live

This order should be sufficient to resume without relying on conversational memory.
