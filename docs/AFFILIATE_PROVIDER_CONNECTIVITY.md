# Affiliate provider connectivity

Verified baseline: 2026-08-14. Re-check every program before activation because eligibility, commission terms, APIs and platform rules can change.

## Design rule

Recommendation selection happens before affiliate lookup. Commission must never influence which product wins recommendation ranking. A selected product may be monetized only after the Affiliate Trust Guard passes.

## Prepared providers

### Impact.com — highest automation potential

Candidate programs: Native Instruments, iZotope, Plugin Alliance, Output.

Impact's Partner API supports creating tracking links from an exact HTTPS deep link and supports media-property IDs and sub IDs. It also exposes Actions, Reports, Contracts and other partner data. SNS-AI now contains a dormant `src/monetization/providers/impact.mjs` adapter that can create a tracking URL after credentials and a ProgramId exist.

Manual gate before live use:

1. Apply to and be approved for each desired program.
2. Record the approved Impact ProgramId for each merchant.
3. Create/identify the Impact media property corresponding to the social account.
4. Add `IMPACT_ACCOUNT_SID` and `IMPACT_AUTH_TOKEN` as repository secrets; never commit or paste them into issues/PRs/chat.
5. Reverify program terms and permitted social placements.
6. Change the registry status only after approval and explicit re-verification.

Official API reference: https://integrations.impact.com/impact-publisher/reference/create-a-tracking-link

### Plugin Boutique / Loopmasters / Loopcloud

These programs expose affiliate links/dynamic linking after approval. The underlying affiliate stack can support APIs, but API access for a normal affiliate account is not assumed until the approved dashboard confirms it.

Manual gate before live use:

1. Apply and obtain the affiliate identifier.
2. Copy the exact dynamic-link template shown in the approved dashboard.
3. Confirm whether API/report export is enabled for the account.
4. Store identifiers/config only in the approved non-secret configuration location; secrets/tokens stay in repository secrets.
5. Reverify social-media placement and disclosure terms.

Plugin Boutique program information: https://help.pluginboutique.com/hc/en-us/articles/6232502500756-Do-you-have-an-affiliate-program

### PluginFox / Affiliatly

PluginFox currently advertises an affiliate program and assigns a unique affiliate link after manual approval. Affiliatly can expose reporting APIs, but availability for PluginFox affiliates is treated as conditional until the approved account confirms it.

Program page: https://pluginfox.com/pages/affiliate

### Manual-link providers

Best Service, Waves, Kilohearts, sonible, Mastering The Mix, Audio Plugin Deals and Loot Audio are retained as candidates. They can still be automated inside SNS-AI after approval by storing the approved affiliate/deep-link format in the registry, even if the provider has no public affiliate API.

Useful current program pages:

- Best Service: https://www.bestservice.com/en/affiliate_program.html
- Waves: https://www.waves.com/affiliate-program
- Kilohearts: https://kilohearts.com/faq/i_have_an_online_audience_can_i_be_an_affiliate
- sonible: https://www.sonible.com/affiliate-dashboard/
- Mastering The Mix: https://www.masteringthemix.com/pages/affiliate-request-form
- Loot Audio: https://www.lootaudio.com/support/article/affiliate-scheme

## Registry lifecycle

`config/affiliate-programs.json` is intentionally non-secret. Every candidate starts as `application_required`. Approval alone is not enough for live linking: re-verification remains required so stale terms cannot silently activate monetization.

Recommended lifecycle:

`application_required -> applied -> approved -> reverify -> configure provider IDs/secrets -> dry-run link resolution -> Trust Guard -> controlled approval post -> live`

Do not change a program to live-ready merely because an affiliate dashboard exists.

## Tracking strategy

When providers permit it, use a post-specific sub ID such as a stable slot/post identifier. This lets revenue be measured separately from editorial recommendation quality. Revenue data must remain downstream of recommendation selection and should be evaluated together with trust/engagement impact rather than optimized in isolation.
