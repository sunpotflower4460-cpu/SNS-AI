# Quote / Message account recovery brief

This file is the durable planning source of truth for the future **quote / message brand** in SNS-AI.

The brand is planned as a paired presence on **X + Instagram**. Exact public account names and final account IDs are intentionally undecided. For implementation planning, provisional IDs may be referred to as `quote-message-x` and `quote-message-instagram`, but these are not yet active accounts and must not be created/enabled solely because this document exists.

Everything below is **account-specific** to this quote/message brand unless explicitly described as shared SNS-AI infrastructure. Do not inherit this concept, persona, quote rules, visual voice, or editorial priorities into unrelated accounts.

## One-sentence concept

**心に残る言葉を、今日を生きる力に翻訳する。**

Primary audience-facing promise:

**今の自分に必要な言葉が、ひとつ見つかる場所。**

The account is not meant to be a generic quote bot, motivational-spam account, or unattributed quote image feed. Its differentiation is:

**good words + provenance discipline + quiet interpretation + consistent visual craft + room for the owner's own message.**

## Primary persona

Core reader:

**自己啓発っぽすぎるのは苦手。でも、ふとした一言に救われることはある人。**

Typical context:

- roughly 20s–40s, but age is not a hard targeting rule
- casually scrolls X or Instagram rather than actively studying self-help
- experiences ordinary stress around work, relationships, future, money, dreams, loneliness, comparison, fatigue, or uncertainty
- dislikes loud positivity, preaching, hustle culture, and claims such as “絶対うまくいく”
- may save/share a phrase that feels quietly relevant to the current day
- values words that leave room for interpretation instead of explaining everything

The main follow reason should be:

**“たまに、今の自分にちょうど必要な言葉が流れてくる。”**

## Editorial personality

The voice should feel like **a quiet person who keeps finding and placing good words nearby**, not a teacher, life coach, therapist, or authority figure.

Preferred qualities:

- calm
- concise
- non-preachy
- emotionally intelligent without pretending clinical expertise
- not relentlessly positive
- willing to say that rest, distance, uncertainty, changing direction, or not having an answer can be valid
- leaves some silence around the quote

Avoid:

- “頑張れば必ず報われる” style certainty
- guilt-based encouragement
- diagnosing the reader
- exploiting vulnerability
- excessive emotional hooks
- every post being about fatigue, anxiety, or healing
- verbose explanation that overwhelms the quote

## Content classes

Every post must have one explicit internal content class. Never blur these categories.

### 1. `VERIFIED_QUOTE`

A real quotation attributed to a real person or a source that can be verified with sufficient confidence.

Requirements:

- verify quotation text, speaker/author, and preferably original/primary or highly reliable provenance
- do not rely on quote-aggregation sites alone when attribution is uncertain
- if a famous attribution is disputed or unsupported, do not present it as verified
- translation must preserve meaning and should not silently turn a loose paraphrase into a direct quote
- store provenance and verification metadata for later audit

### 2. `ATTRIBUTION_UNKNOWN`

A circulating phrase whose author/source cannot be established confidently.

Requirements:

- never attach a famous person's name as a guess
- label appropriately as `作者不詳` only when the wording itself is worth sharing and provenance uncertainty is acceptable
- otherwise prefer not to publish it

### 3. `ORIGINAL_WORDS`

Original wording generated/editorially shaped by the system.

Public presentation should normally use a neutral label such as:

- 今日のことば
- 今日、置いておきたい言葉

Do not falsely frame these as historical quotations or attach invented authorship.

### 4. `OWNER_MESSAGE`

A message the owner explicitly wants to deliver.

This class has editorial priority over performance optimization. SNS-AI must not suppress an owner message merely because learned strategy predicts weaker reach.

Requirements:

- preserve the intended meaning
- editing may improve clarity and platform fit, but should not overwrite the owner's core message
- it may be published anonymously / under the account voice when the owner does not want personal attribution
- never disguise an owner message as a historical quote from another person

## AI original-word quality pipeline

`ORIGINAL_WORDS` must never be “generate once and publish”. The planned pipeline is:

1. select a theme / emotional context
2. generate a diverse candidate pool, initially around 12–20 candidates
3. remove generic clichés and near-duplicates
4. critique candidates from multiple dimensions
5. rewrite only promising candidates
6. compare finalists side by side
7. perform quote-similarity / phrase-search checks where practical
8. final quality gate
9. only then proceed to image composition

### Quality dimensions

Planned internal scores, each 0–100 unless otherwise stated:

- `meaningClarity` — does the sentence actually mean something coherent?
- `naturalness` — does it sound like human language rather than generic AI copy?
- `originality` — is it more than a familiar cliché with synonyms replaced?
- `resonance` — can the phrase stay with a reader after one glance?
- `restraint` — does it avoid preaching/explaining too much?
- `emotionalHonesty` — does it avoid false certainty or empty positivity?
- `brandFit` — does it sound like this quiet account?
- `existingQuoteSimilarityRisk` — risk that wording is too close to a known quote or widely circulating phrase

Initial guardrail targets for future implementation may start around:

- `meaningClarity >= 85`
- `naturalness >= 85`
- `originality >= 75`
- `restraint >= 75`
- `existingQuoteSimilarityRisk <= 20`

These are starting thresholds, not immutable scientific optima. Human review and real audience response may tune them later without lowering attribution or safety standards.

### Common AI failures to reject

Examples of failure patterns rather than forbidden exact wording:

- “雨の後には必ず虹が出る” style generic positivity
- “諦めなければ夢は叶う” certainty
- mirrored phrases that sound profound but collapse under scrutiny
- abstract noun stacking with no concrete meaning
- excessive contrast templates: “○○ではなく、△△だ” on every post
- fake profundity
- advice presented as universal truth
- accidental imitation of a famous quote

## Existing-quote similarity / plagiarism-risk control

Before publishing a strong `ORIGINAL_WORDS` finalist, the system should search distinctive phrases when web search is available.

If a very similar known quotation or widely circulated wording appears:

- rewrite substantially, or
- reject the candidate

This is not intended as a legal plagiarism detector; it is an editorial originality safeguard.

## Verified-quote provenance policy

For `VERIFIED_QUOTE`, factual trust matters more than posting frequency.

Preferred evidence order:

1. original work / speech / interview / archival source when available
2. official institution, estate, publisher, or authoritative transcript
3. high-quality scholarly/reference source
4. reputable secondary source when primary material is impractical

If attribution remains materially uncertain, downgrade to `ATTRIBUTION_UNKNOWN` or do not post.

Store enough source detail so a later session can audit why the quote was accepted.

## Image-generation architecture

This is a core quality requirement.

**Do not ask an image model to render the final Japanese quote text.**

Planned production flow:

quote finalized → background generated/selected → deterministic code-based typography → visual QA → platform export.

### Background generation

AI image generation may create **backgrounds only** or primarily visual scenes with intentionally reserved negative space.

Possible visual pools:

- morning light
- night / moon / stars
- rain / wet window
- forest / nature
- quiet room
- city at dusk/night
- sky / clouds
- minimal abstract texture
- seasonal scenes
- subtle photographic still life

The system should track recent visual compositions and avoid near-identical backgrounds, camera angles, dominant motifs, and layouts over a rolling window.

The visual identity should be recognizable without becoming repetitive.

### Deterministic typography layer

Quote text, attribution, and small labels should be added **after background generation** using code (for example SVG/Canvas or another deterministic renderer).

Goals:

- exact Japanese text
- no AI spelling errors
- predictable line breaks
- consistent punctuation
- consistent author/source formatting
- responsive font sizing based on quote length
- safe margins for X and Instagram crops
- high contrast / readable overlay
- restrained placement

Planned layout classes:

- short quote → large type / generous whitespace
- medium quote → balanced 2–4 line layout
- long quote → smaller type with stronger line-break logic; reject if readability would become poor
- attribution → visually secondary

Do not force every quote onto an image if the quote is too long for a high-quality composition. The system may choose a shorter passage or another quote instead.

## Visual QA

Every composed image should pass automated checks before posting.

Important checks:

- rendered text exactly matches the approved quote string
- attribution/source label exactly matches approved metadata
- no text clipping
- no overflow outside safe area
- sufficient contrast
- readable font size
- acceptable line count
- no unintended background text/signage that competes with the quote
- no obvious image-generation artifact in focal area
- no recent visual near-duplicate
- platform-specific dimensions/export valid

A semantic vision review may be used in addition to deterministic checks, not instead of them.

## X presentation strategy

The quote/image is the hero. Commentary must not compete with it.

Default preference:

- main post: quote image + minimal text / attribution if needed
- optional interpretation: small and infrequent

Planned commentary modes:

1. `NONE` — no extra interpretation; preferred when the quote stands alone
2. `SELF_REPLY` — a quiet one-sentence interpretation as a reply to the account's own post when the current X API/account permissions safely support it
3. `CAPTION_TAIL` — a subtle one-liner at the end of the main post when self-reply is unavailable or undesirable

The system must not depend on `SELF_REPLY` as the only path. Platform/API behavior can change; use a fail-safe fallback.

Interpretation should normally be lower visual/emotional weight than the quote. Do not explain the quote to death.

Possible tone:

- 「今日は少しだけ、覚えておきたい言葉です。」
- 「答えを急がなくてもいい日に、置いておきたい言葉。」

Not every post needs an interpretation. The system should learn whether `NONE`, `SELF_REPLY`, or `CAPTION_TAIL` performs best without making the feed formulaic.

## Instagram presentation strategy

Instagram should preserve the same brand/personality while using a more visual presentation.

Default:

- image itself contains the quote and restrained attribution
- caption may contain source/provenance where appropriate
- optional short interpretation after spacing, visually subordinate to the quote

Future experiments:

- single quote card
- two-slide carousel: quote first, small interpretation second
- subtle animated/reel form only after video/media infrastructure is stable and rights/quality are clear

Do not make every post a long carousel. Saving/sharing a single clean quote card is an important use case.

## Theme diversity

The account should not become an endless “疲れているあなたへ” feed.

Maintain diversity across themes such as:

- rest
- starting / beginning
- persistence
- letting go
- comparison
- relationships
- loneliness
- courage
- uncertainty
- failure
- creativity
- self-respect
- change
- time
- kindness
- ambition
- ordinary happiness
- boundaries
- choosing a different path
- not knowing yet

Learning may adjust frequency, but no single emotionally vulnerable theme should dominate solely because it performs well.

## Owner-message insertion model

The owner can at any time provide a thought, rough sentence, theme, or full message.

Planned internal mode:

`OWNER_MESSAGE`

Behavior:

- preserve the owner's intention
- optionally generate several polished variants for approval
- adapt separately for X and Instagram
- create a matching quote image if desired
- bypass normal trend/performance topic selection
- still pass safety, formatting, factual, and visual QA

Performance learning must not rewrite the account's values or suppress the message.

## Growth strategy

The account should optimize for **meaningful retention and sharing**, not raw impressions alone.

High-value metrics when available:

- bookmarks/saves
- shares/reposts
- follows
- unfollows
- profile visits
- replies/comments
- impressions as denominator

Potential future derived metrics:

- `Save Value = saves / impressions`
- `Share Value = shares / impressions`
- `Follow Yield = follows / impressions`
- `Follow Damage = unfollows / impressions`

A quiet post with modest reach but exceptional saves/shares may be more valuable than a viral but disposable phrase.

Performance optimization must never reward increasingly manipulative or emotionally alarming content.

## Reply / DM philosophy

Replies and DMs may later be used to understand which themes resonate or what readers want more of, but this is not primarily a counseling account.

Boundaries:

- do not present the AI as a therapist or crisis professional
- avoid diagnosing users
- low-risk conversational replies may eventually be automated after approval-mode validation
- sensitive or high-risk messages should not receive casual generated advice
- use inbound conversation as theme research only within privacy/safety boundaries

## Monetization posture

Monetization is secondary for this brand.

Potential future categories may include books, journaling tools, stationery, reading/listening services, or other genuinely aligned products, but any affiliate model must preserve editorial trust.

Do not force product promotion into emotionally vulnerable posts.

Do not let affiliate availability determine which quote/theme is selected.

The account's larger strategic value may be **audience and message reach**, not maximum affiliate revenue.

## X + Instagram relationship

These are two platform expressions of the same quote/message brand, not two unrelated personas.

Shared:

- concept
- persona
- quote provenance
- original-word quality rules
- visual identity
- owner-message intent

Platform-specific:

- composition size
- caption length
- commentary placement
- carousel usage
- posting cadence
- engagement mechanics

Do not mechanically repost screenshots from X to Instagram. Render each platform natively from the same approved quote object.

## Planned canonical quote object

Future implementation should consider a structured internal object similar to:

```json
{
  "id": "...",
  "class": "VERIFIED_QUOTE | ATTRIBUTION_UNKNOWN | ORIGINAL_WORDS | OWNER_MESSAGE",
  "textJa": "...",
  "originalText": "...",
  "author": "...",
  "source": {
    "url": "...",
    "title": "...",
    "verifiedAt": "...",
    "confidence": 0.0
  },
  "theme": "...",
  "quality": {
    "meaningClarity": 0,
    "naturalness": 0,
    "originality": 0,
    "resonance": 0,
    "restraint": 0,
    "emotionalHonesty": 0,
    "brandFit": 0,
    "existingQuoteSimilarityRisk": 0
  },
  "commentary": {
    "mode": "NONE | SELF_REPLY | CAPTION_TAIL",
    "text": "..."
  },
  "visual": {
    "backgroundTheme": "...",
    "layoutClass": "...",
    "renderedAsset": "..."
  }
}
```

Exact schema may change during implementation; provenance/class separation is the important invariant.

## Current state

At the time this document was created:

- this is a **planned account pair**, not an activated account
- final public names are undecided
- no X/Instagram account config has been enabled for this brand
- no live posting is authorized
- no automated quote-image production pipeline has yet been implemented specifically for this brand
- no AI quote quality scorer has yet been implemented specifically for this brand
- no real owner message has been queued
- existing shared SNS-AI safety/research/analytics infrastructure may be reused later

Do not confuse this planning document with completed runtime implementation.

## Next implementation priorities when returning

1. create dormant paired account configs for X and Instagram after names/IDs are chosen
2. implement the canonical quote/content-class model
3. implement verified-quote provenance checking/storage
4. implement AI original-word multi-stage generation + scoring
5. implement distinctive-phrase similarity search for `ORIGINAL_WORDS`
6. implement background-only generation / visual pool
7. implement deterministic Japanese typography renderer
8. implement deterministic + semantic visual QA
9. implement X commentary fallback (`NONE` / `SELF_REPLY` / `CAPTION_TAIL`)
10. implement native Instagram rendering / optional carousel
11. implement performance learning emphasizing saves/shares/follows without emotional manipulation
12. implement `OWNER_MESSAGE` priority path
13. keep live posting disabled until normal preflight/approval/manual external setup is complete

## Recovery order for a future session

When returning to this quote/message account after working on other accounts:

1. `docs/QUOTE_MESSAGE_ACCOUNT_RECOVERY.md` — this planning/recovery source of truth
2. future account entries in `config/accounts.json` once created
3. future quote-specific schema/renderer/quality files once implemented
4. shared engagement/safety/manual setup docs
5. actual quote history, performance metrics, and human feedback after launch

The repository should remain sufficient to recover this design without relying on the original chat conversation.
