# Music discovery / artist introduction account recovery brief

This file is the durable planning source of truth for the future **music discovery / artist introduction brand** in SNS-AI.

The brand is planned as a paired presence on **X + Instagram**. Exact public names and final account IDs are intentionally undecided. Provisional internal IDs may later be `music-discovery-x` and `music-discovery-instagram`, but this document alone must not create or enable live accounts.

Everything below is **account-specific** to this music-discovery brand unless explicitly described as shared SNS-AI infrastructure. Do not copy its concept, persona, editorial voice, music-selection rules, or self-related release behavior into unrelated accounts.

## One-sentence concept

**まだ知らない、好きになる一曲を見つける。**

Brand tagline:

**まだ出会っていない音楽へ。**

The account is not primarily a release-news feed, chart account, review site, artist-ranking account, or a promotional shell for one artist. Its value is:

**discovery + context + fit + an easy path to listen.**

The account should help a reader answer, within seconds:

- what is this song?
- what kind of feeling / scene does it suit?
- why might I care?
- where can I hear the full track?

## Primary persona

Core reader:

**有名曲だけではなく、自分だけの「好き」をもっと見つけたい音楽好き。**

Typical context:

- enjoys music frequently but does not want to search every platform manually
- likes the feeling of discovering an artist or song before it becomes familiar
- may follow major artists but also wants indie, overseas, overlooked, old, niche, or unexpected tracks
- reacts more strongly to mood, scene, lyrics, sound, story, or atmosphere than to chart rank alone
- wants a quick reason to press play instead of a long critical review
- does not necessarily identify as a music expert

Main follow reason:

**“流れてくる曲の中に、ときどき自分だけの『好き』が見つかる。”**

## Editorial personality

The voice should feel like **a music lover who quietly brings over a song they think someone may love**, not a judge, critic, label press office, or hype machine.

Preferred tone:

- curious
- concise
- warm but not exaggerated
- descriptive rather than authoritative
- able to say “this may fit people who…” rather than “everyone should hear this”
- interested in mood, arrangement, lyrics, sonic texture, artist story, and listening context
- comfortable featuring obscure and famous music under the same editorial standard

Avoid:

- ranking human worth or artistic value
- pretending to have listened when the system has not actually analyzed or lawfully accessed the track
- invented artist biography or song meaning
- clickbait such as “知らないと損” / “絶対泣く”
- only promoting trending or major-label releases
- becoming a generic “new release out now” feed

## Editorial selection principle

The core selection question is not “is this famous?” but:

**“Could this become someone’s next favorite song, and can we explain the doorway into it?”**

Potential discovery pools:

1. under-covered indie artists
2. strong songs from smaller artists
3. overseas songs not yet saturated in Japanese feeds
4. overlooked catalog tracks from known artists
5. older songs worth rediscovering
6. unusual arrangements, production, lyrics, or sound design
7. emotionally or scenically distinctive tracks
8. new releases with a clear reason to recommend them
9. user / artist submissions after a safe submission system exists
10. related releases connected to the account owner, evaluated using the same editorial criteria

Do not force all genres into one post. Genre scope can remain broad initially, but the system should learn which musical qualities create meaningful follows, saves, shares, profile visits, and full-listen clicks.

## The Song Card: canonical content object

Every song introduction should first become a structured internal `SongCard`, independent of platform rendering.

Suggested fields:

```json
{
  "songId": "stable internal id",
  "title": "Song title",
  "artist": "Artist name",
  "releaseUrl": "canonical official release or artist URL",
  "listenLinks": {
    "youtube": null,
    "spotify": null,
    "appleMusic": null,
    "other": []
  },
  "hook": "one-line doorway into the song",
  "moods": ["night", "quiet"],
  "scenes": ["walking home alone"],
  "forFansOf": [],
  "editorialNotes": [],
  "notableMoment": null,
  "sourceEvidence": [],
  "rights": {
    "artwork": "unknown|link_only|licensed|owned",
    "audio": "unknown|link_only|licensed|owned",
    "video": "unknown|link_only|licensed|owned"
  },
  "relationship": "independent|submitted|related_release",
  "commercial": "organic|paid|affiliate"
}
```

This schema is a planning target, not proof that it has been implemented.

The same Song Card should render differently on X and Instagram.

## X presentation strategy

X should optimize for **“3秒で聴くか判断できる”**.

### Default X post structure

1. **visual Song Card**
2. **one-line listening doorway**
3. **two or three compact reasons / descriptors**
4. **official listening path**
5. optional self-reply only when additional context truly adds value

Example shape:

```text
夜、一人で帰るときに聴きたい一曲。

Artist — Song

静かな入りから、途中で景色が少しずつ広がるタイプ。
派手さより余韻が残る曲が好きな人に合いそう。

🎧 [official link]
```

Do not use this exact wording repeatedly. It is a structural example only.

### X Song Card image

A deterministic graphic should normally show only enough information to identify and frame the track:

- artist
- song title
- optional short mood / scene tags
- optional approved artwork or a generated editorial visual when rights permit

Avoid cramming the whole review into the image.

The image should remain understandable at small timeline size.

### X native audio/video preview

Native video is valuable only when the rights state permits it.

Possible preview format:

- 9:16, 1:1, or platform-appropriate video
- approved artwork / owned visual
- simple motion
- title + artist
- short legally usable audio excerpt

Never download a third-party commercial track and repackage it into a promotional clip merely because a streaming link exists.

If audio rights are unknown, use link-first presentation.

## Instagram presentation strategy

Instagram should become a **visual music-discovery library**, not a copy of X.

### Default Carousel

Recommended initial format: 3 slides.

**Slide 1 — discovery hook**

- song title
- artist
- one short listening context such as “夜、一人で歩きながら聴きたい”

**Slide 2 — what it feels like**

- arrangement arc
- sonic texture
- emotional movement
- one or two concrete musical observations that are actually supported

**Slide 3 — who may like it**

- mood / scene
- nearby genres or qualities
- optional “if you like…” only when comparisons are reasonable and not fabricated
- call to listen through the profile discovery hub

Keep text readable and avoid turning every carousel into a dense review.

### Instagram Reels

Use Reels selectively, especially for:

- owned tracks
- licensed / submitted tracks with explicit promotional rights
- artist-provided promo clips
- other content whose rights status is clearly compatible with repost / promotional use

Do not assume that because a track is available in a consumer music library it is automatically available for server-side automated promotional reuse.

When rights are uncertain, fall back to the carousel + official listening path.

## Music Discovery Hub

A high-value future feature is a stable profile link that opens a **Music Discovery Hub** generated by SNS-AI.

The profile URL should remain stable while its contents update automatically.

Suggested sections:

- 今日の一曲
- 最近紹介した曲
- 今週のおすすめ
- 夜に聴きたい
- 朝 / 移動 / 雨 / 作業 / 一人 / 前向き / 静か etc.
- indie
- overseas
- acoustic
- rock
- ambient
- experimental
- artist submissions when enabled

Each entry can route to official YouTube / Spotify / Apple Music / artist pages without forcing the social post itself to carry every URL.

The hub can later become a long-lived discovery database and analytics source.

## Link strategy

Do not hard-code one platform as the only listening destination.

Prefer a canonical song record with multiple official links.

Platform rendering can choose:

- best official landing page
- artist smart-link page
- YouTube when visual / full-track context matters
- Spotify / Apple Music where appropriate
- Music Discovery Hub as the stable social-profile destination

Do not make claims about which social algorithm prefers links in-body vs reply without data. This should be tested empirically rather than treated as folklore.

## Content formats

Rotate formats so the account has consistency without repetition.

Potential series:

- 今日見つけた一曲
- まだあまり知られていない一曲
- 夜に聴きたい一曲
- イントロで惹かれた一曲
- サビよりAメロが好きになる曲
- 30秒後に印象が変わる曲
- 歌詞から入った一曲
- 音作りが面白い一曲
- 昔の曲を一曲だけ掘り起こす
- 今週の3曲
- このアーティスト、もう少し知られてほしい
- 同じ気分で聴ける3曲

Recurring names may remain stable, but hooks, writing structure, visual composition, and musical selection should vary.

## Related releases / owner's music

The user wants their own released music to be eligible for discovery through this account **without turning every related post into “運営者の新曲です” promotion**.

That is compatible with this media concept if handled carefully.

### Internal classification

Use a distinct internal relationship such as:

`relationship = related_release`

This should be retained for audit and analytics even when it is not the headline of the post.

### Editorial treatment

A related release should normally use the **same public Song Card format** as other songs:

- what kind of song is it?
- what moment does it fit?
- what is musically distinctive?
- who may enjoy it?
- where can it be heard?

Do not create fake third-party language such as “偶然見つけました” when the system knows it is related to the account owner.

Do not require a loud “運営の曲です” banner either.

### Transparency

The brand should have a durable disclosure in its profile / discovery hub / editorial policy along the lines of:

**「紹介作品には当メディアと関係のある作品を含む場合があります。」**

The exact Japanese wording can be refined later.

Paid sponsorships, affiliate relationships, gifted promotion, or other commercial relationships must still receive whatever per-post disclosure and platform labeling are required by the applicable policy. The quiet related-release disclosure must not be used to hide paid promotion.

### Ranking principle

Related releases must not be auto-rated “better” merely because they belong to the owner.

The system may intentionally schedule a related release when the user wants to promote it, but descriptive claims should still remain grounded and should not fabricate external acclaim, independent discovery, or listener reactions.

## Rights-aware media policy

Every media asset should carry an explicit rights state before automated publication.

Recommended states:

- `owned` — account owner controls the necessary rights for this use
- `licensed` — explicit promotional permission exists
- `submitted` — artist submitted material under a recorded permission grant
- `official_link_only` — may link/embed via official platform path but do not repackage asset
- `unknown` — do not reuse media; text/link fallback only

Automated transformation should fail closed when rights are unknown.

This is especially important for third-party audio excerpts and cover artwork.

## Artist submission system: future expansion

Once the account has audience value, allow artists to submit tracks.

Potential submission form:

- artist name
- song title
- release links
- short description
- genre / mood
- artwork
- optional 15–30 second promo video/audio
- social accounts
- rights / permission checkbox and legal text for supplied promotional assets
- whether the submission is paid, unpaid, or editorial-only

Submission does **not** guarantee publication.

Editorial ranking should remain separate from payment / affiliate incentives unless a clearly labeled paid-placement product is deliberately created later.

A submission workflow can unlock safe native Reels / X previews because the artist can provide promo-ready media and permission.

## Research and factual accuracy

For artist / release facts, prefer:

1. artist / label official release page
2. artist official website / official social announcement
3. official YouTube / streaming metadata where appropriate
4. credible music press / interviews

Do not invent:

- song meaning
- inspiration
- recording story
- artist background
- genre labels presented as objective fact
- listener reception
- chart performance

If the system has only metadata and no lawful audio analysis, it must not pretend to describe detailed audible features that it did not actually inspect.

## Growth strategy

Primary objective is **quality discovery that creates durable music-following behavior**, not raw impressions alone.

Useful future metrics:

- follows / unfollows
- profile visits
- saves / bookmarks
- shares / reposts
- replies / comments
- Song Card opens
- Music Discovery Hub clicks
- outbound full-listen clicks
- repeat visitors to the hub
- artist submission volume / quality
- owned/related-release listening conversions when relevant

Potential derived metrics:

- `Discovery Follow Yield = follows / impressions`
- `Listen Intent = outbound listen clicks / post views`
- `Save Value = saves or bookmarks / post views`
- `Discovery Depth = hub session song opens / hub sessions`
- `Related Release Conversion = owned-track listening actions / related-release exposures`

Do not optimize the entire account for related-release conversion at the expense of independent discovery value.

## X vs Instagram division of labor

### X

Best for:

- fast discovery
- compact explanation
- conversation
- artist context
- quick links
- weekly / themed threads
- native preview where rights permit

### Instagram

Best for:

- visual discovery
- carousel library
- save/share behavior
- Reels when promotional media rights permit
- consistent visual identity
- long-lived category browsing through profile / hub

The same song may appear on both platforms, but copy and layout should be platform-native rather than duplicated verbatim.

## Relationship to YouTube

YouTube can serve as a full-listen / deeper-content destination when an official video, lyric video, performance, or owned upload exists.

For the user's own music, a future funnel may be:

X discovery post → YouTube / smart link

Instagram Reel or Carousel → Music Discovery Hub → full track

YouTube Short → full video / full song

This is a possible strategy, not a requirement that every song must have a YouTube destination.

## Current SNS-AI implementation reality

SNS-AI already contains general media/video and X/Instagram provider code, but this document does **not** claim that the full music-discovery video workflow is production-ready.

Before live use, verify at least:

- X native video upload path with the actual account scopes
- Instagram Reel container / publish path with current API permissions
- public asset hosting required by Instagram media creation
- audio/video codec and duration limits
- rights metadata enforcement
- media QA
- idempotent publishing
- current platform policy at activation time

Do not activate live accounts merely because the planning document exists.

## Future implementation order

Recommended order:

1. create machine-readable X + Instagram account configs, disabled by default
2. implement canonical `SongCard` schema + validation
3. implement official-link research / metadata ingestion
4. implement deterministic X Song Card image renderer
5. implement Instagram 3-slide Carousel renderer
6. implement Music Discovery Hub data model and static/public rendering path
7. implement rights-state model and fail-closed media gate
8. implement platform-native copy generator from the same Song Card
9. implement post-level duplicate / artist-frequency / genre-diversity guards
10. implement analytics for follow/save/listen intent
11. implement related-release scheduling while preserving the same public editorial format
12. implement licensed/owned native audio-video preview pipeline
13. implement artist submission + permission workflow
14. only then expand automatic Reels / X preview usage

## Manual gates to remember later

Manual/external steps may include:

- creating the actual X and Instagram accounts
- X developer credentials / OAuth scopes
- Instagram professional account / Meta app permissions
- OpenAI API billing / secrets
- public media-hosting setup where needed
- final public account name / bio / visual identity
- music distribution / official listening links for related releases
- artist submission permission wording
- rights agreements for third-party media
- any paid promotion / sponsorship terms

Never ask the user to paste secrets into chat. Keep them in GitHub Actions Secrets or the appropriate external secret store.

## Recovery order for a future session

When returning to this account after working elsewhere, inspect:

1. `docs/MUSIC_DISCOVERY_ACCOUNT_RECOVERY.md` — this source of truth
2. future `config/accounts.json` entries for the X + Instagram accounts
3. future Song Card schema / renderer implementation
4. current media / X / Instagram provider implementation
5. current platform policy and permissions
6. actual post history / analytics once live
7. any related-release or artist-submission records

This should make the account recoverable without depending on the original planning conversation.
