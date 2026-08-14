# New project chat bootstrap prompt — Convenience Discovery Hub

Copy the block below into the first message of the new project chat after creating the new Hub repository and adding the handoff pack files.

---

I want you to build a dedicated Hub for the SNS-AI convenience-discovery affiliate account in this repository.

The core concept is:

**「こんな便利なものがあるんだ」を見つける。**

This Hub is a separate public web product, but it must operate as one system with the existing `sunpotflower4460-cpu/SNS-AI` repository.

Before changing code, read every handoff/design file in this repository in this order:

1. `00_START_HERE.md`
2. `01_PRODUCT_AND_UX_SPEC.md`
3. `02_ARCHITECTURE.md`
4. `03_DATA_CONTRACT.md`
5. `04_SNS_AI_INTEGRATION.md`
6. `05_IMPLEMENTATION_PLAN.md`
7. `06_SECURITY_AND_OPERATIONS.md`
8. `07_ACCEPTANCE_TESTS.md`

Also inspect the current SNS-AI source-of-truth documents:

- `docs/CONVENIENCE_AFFILIATE_ACCOUNT_RECOVERY.md`
- `docs/CONVENIENCE_HUB_HANDOFF.md`

Important requirements:

- Do not turn the Hub into a generic affiliate catalog.
- SNS-AI owns product discovery, editorial scoring, provider integration and social publishing.
- Hub owns public product pages, problem-first navigation, search, stable URLs and current route presentation.
- The Hub must be ready before SNS-AI publishes a Hub-dependent X/Instagram post.
- Start with a Git-backed canonical product store unless there is a concrete blocker.
- Keep product identity separate from affiliate offer/route identity.
- Affiliate commission must never determine editorial ranking.
- Preserve old product URLs even when a product is discontinued.
- Never silently replace an old product with a different “similar” product.
- Do not commit or request secrets in chat.
- All writes should be idempotent and recoverable.
- Build mobile-first.
- Add CI and representative fixtures early.
- Work in small, verifiable phases.
- Prefer completing all repository-side work automatically before asking me for manual setup.
- Do not enable any real affiliate/live integration until repository-side implementation and tests are ready.

First inspect the repository and the SNS-AI source-of-truth documents, then create the initial architecture/bootstrap and proceed through the implementation plan in order.

---

Provisional repository name:

`Convenience-Discovery-Hub`

The public brand name can remain undecided during implementation.
