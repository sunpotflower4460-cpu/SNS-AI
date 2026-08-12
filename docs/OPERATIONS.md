# SNS-AI Operations

この文書は、鍵を入れる前後の確認・人間フィードバック・障害切り分けをまとめた運用手順です。

## 1. 鍵を入れる前

次をローカルまたは CI で実行します。

```bash
npm test
npm run validate
npm run check
npm run smoke
npm run doctor
```

`npm run smoke` は外部 API や秘密情報を使わず、設定・相対スコアリング・学習済み候補ランキングの主要経路を合成データで通します。

`npm run doctor` は秘密値を表示せず、Secret の存在、JSON の形、各アカウントに必要な credential key、Instagram media の準備状態を確認します。

## 2. 鍵を入れた後

Actions → **SNS Live Preflight** を実行します。

Live Preflight は投稿を作成しません。以下だけを確認します。

- OpenAI API キーが実際に認証できるか
- X OAuth User Context が `/2/users/me` を読めるか
- Instagram access token / igUserId が対象アカウントを読めるか

すべて通った後に、Autopilot を `force=true / dry_run=true` で確認し、その後に実投稿テストへ進みます。

## 3. Readiness report

**SNS Health Report** が毎日 Doctor を実行し、状態が変わった場合だけ次を更新します。

- `data/reports/readiness.json`
- `data/reports/readiness.md`

Secret の実値は記録しません。`present / missing / invalid JSON` のような状態だけ残します。

## 4. 人間フィードバック

数字からの自動学習より、人間の明示的な修正を上位に置きます。

保存先:

```text
data/human-feedback.jsonl
```

アクション:

- `prefer` — この方向を増やす
- `avoid` — この方向を避ける
- `correct` — AI の理解・学習を訂正する
- `pin` — 特に重要な方針として保持する
- `note` — 補足情報

Actions → **SNS Human Feedback** から登録できます。

ChatGPT から GitHub Issue を橋にする場合は、タイトルを:

```text
[feedback] account-id
```

本文を JSON にします。

```json
{
  "account": "account-id",
  "action": "avoid",
  "note": "煽るような冒頭はこのアカウントでは使わない",
  "dimension": "hook",
  "source": "chatgpt"
}
```

成功すると Issue は自動で閉じられ、次回生成から反映されます。

> Public repository の場合、Issue と `data/human-feedback.jsonl` は公開情報になります。公開したくない運用指示を扱う場合は repository を Private にしてください。

## 5. 優先順位

生成時の優先順位は次です。

1. アカウント identity / explicit instructions / safety
2. active human feedback
3. factual / platform constraints
4. learned strategy
5. trend brief

反応が良くても、人間が `avoid` / `correct` した方向へ自動最適化しません。

## 6. CI

**SNS-AI CI** は pull request と main push で自動実行します。

- unit tests
- config validation
- syntax checks
- keyless smoke
- key-safe doctor

外部 Secret がなくても CI 自体は動きます。

## 7. 障害時の確認順

1. `data/reports/readiness.md`
2. GitHub Actions の失敗 workflow
3. 対象アカウントの `enabled / mode`
4. `SOCIAL_CREDENTIALS_JSON` の credentialKey
5. `SNS Live Preflight`
6. `data/history.jsonl` / `data/state.json`
7. platform API の権限・期限

鍵の値そのものを Issue やログへ貼らないでください。
