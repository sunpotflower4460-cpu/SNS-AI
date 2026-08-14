# Affiliate Trust Policy

This document defines the trust-first monetization policy for SNS-AI. The implementation is intentionally dormant by default: affiliate publishing is disabled until the operator explicitly enables it for an account.

This is an engineering and editorial policy, not legal advice. Re-check applicable law, platform policy, affiliate-program terms, and product-specific restrictions before enabling monetization.

## Core principle

Recommendation quality must be decided before monetization availability.

The system must not rank a product higher because it pays a larger commission, has an affiliate program, or offers a temporary commercial incentive. The desired ordering is:

1. decide whether the product is genuinely worth mentioning for the audience
2. compare relevant alternatives, including free and non-affiliate options
3. select the recommendation on usefulness and fit
4. only after selection, check whether an affiliate relationship exists
5. if commercial, apply disclosure and trust safeguards before publishing

`allowCommissionInRanking` is therefore required to remain `false` for affiliate publishing.

## Default safeguards

The repository defaults are deliberately conservative:

- affiliate publishing disabled
- maximum prospective affiliate share: 20% of the recent configured window
- 20-post evaluation window
- at least 4 organic published posts before the first affiliate post
- at least 4 organic published posts between affiliate posts
- at least 48 hours between affiliate posts
- explicit in-post disclosure required
- benefits and limitations/trade-offs required
- at least one alternative must be considered
- X paid-partnership labeling required
- commission must not influence recommendation ranking

These are safe starting constraints, not claims that 20% or 48 hours are universally optimal. They should only be relaxed after real account data shows that trust and ordinary-post performance remain healthy.

## Disclosure

Default Japanese disclosure text:

`広告・アフィリエイトリンクを含みます`

The guard requires the configured disclosure to appear in the post itself. Do not move the disclosure to a reply, profile-only notice, hidden landing page, or other location users may not see with the recommendation.

For X, approved affiliate posts are also marked as paid partnerships through the official API field `paid_partnership: true`.

Official references checked during implementation:

- Consumer Affairs Agency, Japan — stealth marketing Q&A: https://www.caa.go.jp/policies/policy/representation/fair_labeling/faq/stealth_marketing/
- X Paid Partnerships Policy: https://help.x.com/en/rules-and-policies/paid-partnerships-policy
- X Create Post API (`paid_partnership`): https://docs.x.com/x-api/posts/create-post

## Balanced recommendation metadata

An affiliate payload must carry review evidence separately from the public copy:

```json
{
  "commercial": {
    "kind": "affiliate",
    "recommendation": {
      "pros": ["specific benefit"],
      "cons": ["specific limitation or trade-off"],
      "alternativesConsidered": ["free or non-affiliate alternative"]
    }
  }
}
```

This metadata exists so the system cannot silently turn an affiliate link into an unqualified endorsement. The public post does not need to print these arrays literally, but the generated recommendation should faithfully reflect the underlying trade-offs.

## Publish-boundary enforcement

`src/monetization/trust-guard.mjs` is called from the final publisher boundary. An affiliate payload is rejected before the provider call when any required safeguard fails.

Examples of hard failures include:

- affiliate mode is not explicitly enabled
- commission ranking is permitted
- disclosure text is missing
- recommendation has no benefit or no limitation
- no alternative was considered
- recent affiliate share would exceed the configured cap
- there are too few organic posts before/between affiliate posts
- cooldown has not elapsed
- numeric trust limits are invalid

Because this check runs at publish time, approval/manual paths cannot bypass it merely by skipping generation-time rules.

## X labeling

X currently defines affiliate links, discount codes, gifted products, and other compensation/incentives as paid-partnership scenarios in its policy. The current implementation adds official X API support for `paid_partnership` and automatically requests that label for trust-guard-approved affiliate posts when `requireXPaidPartnership` is enabled.

Normal organic posts never set this field.

## What is intentionally not implemented yet

The repository does not yet automatically discover affiliate programs, enroll in them, rewrite links, or optimize against commission/revenue. Those capabilities should be added only when real program credentials and terms are available.

When that phase begins, build an Affiliate Registry containing at minimum:

- product and manufacturer
- canonical official URL
- affiliate URL / program identifier
- allowed geography
- program status and expiry
- disclosure requirements
- last verification time
- commercial restrictions

Affiliate availability should remain metadata applied after recommendation selection, never a ranking feature.

## Future learning objective

When affiliate posts are eventually enabled, success should not be defined by revenue alone. The learning layer should track at least three separate dimensions:

1. **Trust** — follower/ordinary-post health after commercial posts, negative responses, and account-level degradation signals
2. **Utility** — useful engagement, qualified clicks, discussion, and audience fit
3. **Revenue** — conversions and commission

Optimization priority should remain `Trust > Utility > Revenue`. A commercially successful post that damages subsequent organic performance should not be treated as a successful pattern.
