# Engagement delivery guard

SNS-AI uses a privacy-safe durable delivery ledger for live inbound replies and DM replies.

Before a provider mutation is attempted, the interaction's hashed `eventKey` is reserved on the existing `sns-ai-state` branch with status `sending`. The ledger stores only operational metadata such as account, platform, interaction kind, timestamps, and status; it does not store inbound message bodies, provider participant IDs, generated response text, or private DM content.

If the provider definitely rejects the request with a client-side response that proves non-acceptance, the claim can be marked `failed` and a later run may retry after the underlying cause is corrected.

If the provider result is ambiguous — for example, a network failure where the provider may already have accepted the message — the claim becomes `unknown`. Automatic retry is blocked. SNS-AI creates a `needs-human` Issue with privacy-minimized metadata so the operator can check the provider account. Closing that Issue records the interaction as handled and prevents future automatic resend.

If the provider accepted the response but the runner crashes before normal engagement bookkeeping reaches durable storage, the earlier `sending` claim still survives. The next run therefore stops rather than risking a duplicate.

Resolved delivery records are retained longer than the runtime's 30-day inbound processing window. Unresolved `sending` and `unknown` records are not aged out automatically.

This is intentionally an at-most-once bias: in the rare ambiguous crash window SNS-AI may ask for human verification rather than sending twice.
