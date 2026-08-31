# Architecture

SNS-AI はアカウント単位の投稿エンジンを残したまま、その上に **Brand → Channel** 層を載せた Growth Operating System です。

```text
Brand
  ├─ shared research / core content brief
  ├─ X account
  └─ Instagram account
        ↓
Research → Select → Verify → Create → Media Match → Publish → Measure → Learn → Experiment → Reallocate Budget → Improve
```

人格・事実・権利・予算・Manual-Only 安全ロックは、成長指標より常に上位です。

## 層

| 層 | 役割 | 主なモジュール |
|---|---|---|
| Brand | 3ブランド（Plugin Radar / Artist / Brand C scaffold） | `config/brands.json`, `src/brands/` |
| Research | 同一ブランドの調査を X/Instagram で二重実行しない | `src/research/shared.mjs`, `src/research/trends.mjs` |
| Brief | Core brief → X版 / Instagram版へ分岐 | `src/brands/brief.mjs`, `src/content/platform-adapt.mjs` |
| Media | Hunter + entity verification + brand card | `src/media/hunter.mjs`, `src/media/entity-verify.mjs`, `src/media/brand-card.mjs` |
| Artist | evidence levels, mix, 手動投稿との共存 | `src/artist/` |
| Budget | 月 $20 governor, URL 投資, 再配分 | `src/budget/` |
| Router | cheap / balanced / high / critical | `src/ai/router.mjs` |
| Account | 既存の publish unit。`music-tools-x` は維持 | `config/accounts.json` |

## 後方互換

- Plugin Radar の X アカウント ID は **`music-tools-x`** のままです（`credentialKey` も同名）。
- `example-x` / `example-instagram` は変更していません。
- 既存の RSS / GitHub Releases / Groq triage / linkPolicy / learning / experiments はそのまま動きます。

## 安全

`config/runtime-policy.json` の Manual-Only ロックは解除しません。全アカウントは `enabled: false`、affiliate は無効、定期投稿 schedule は入れません。
