# Creator Action Queue

SNS-AI は recommendation を生成する側です。Creator UI は作りません。

`artist.hybridMode: true` のときだけ、人間への小さなお願いを出せます。純自動アカウントでは人間への request を前提にしません。

type: `asset_request` / `taste_confirmation` / `context_request` / `story_request` / `capture_request` / `approval_request`

Asset request は必ず `requestId`, `type`, `priority`, `requestedAssetType`, `reason`, `evidence`, `confidence` を持ちます。confidence が低い、または根拠がない大量リクエストは出しません。

Taste confirmation:

- yes → `taste_match` を `confirmed_personal` へ昇格可能な event
- no → confirmed にしない（avoid 候補）
- neutral → `taste_match` のまま

AI が勝手に昇格しません。

実装: `src/artist/actions.mjs`。輸送契約の提案は [GROWTH_BRIDGE_CONTRACTS.md](GROWTH_BRIDGE_CONTRACTS.md)。UI は [MY_SNS_INTEGRATION.md](MY_SNS_INTEGRATION.md)。
