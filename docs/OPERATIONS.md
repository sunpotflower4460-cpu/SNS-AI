# SNS-AI Operations

この文書は、初回開通・長期無人運用・障害・人間フィードバックの運用手順です。

## 1. 鍵を入れる前

CI / ローカルで実行:

```bash
npm test
npm run validate
npm run check
npm run smoke
npm run secret-scan
npm run doctor
```

- `check` — `src/**/*.mjs` を自動発見して全て構文確認
- `smoke` — 外部APIなしで主要ロジックを合成データ検証
- `secret-scan` — ソース・設定・Workflow・docs内の典型的な秘密情報リテラルを検出
- `doctor` — Secret値を出さず、設定・必要credential・media準備・任意の`expiresAt`を確認

## 2. Secrets / Variables

必須:

- `OPENAI_API_KEY`
- `SOCIAL_CREDENTIALS_JSON`

外部media endpoint使用時のみ:

- `MEDIA_SERVICE_TOKEN`

任意Variables:

- `OPENAI_MODEL`
- `SNS_COMMAND_ADMINS` — カンマ区切り。所有者以外に `[publish]` / `[feedback]` を許可するGitHubユーザー
- `APPROVAL_MAX_AGE_DAYS` — approvalの失効日数。未設定7日

鍵はIssue / README / configへ貼らないでください。

## 3. 鍵を入れた後

Actions → **SNS Live Preflight**。

投稿は作成せず次を確認します。

- OpenAI API認証
- X `/2/users/me`
- Instagram対象アカウント読取
- 内蔵画像hostingを使う場合、GitHub repositoryがpublicか

内蔵画像生成そのものは費用が発生するためPreflightでは生成しません。画像モデルの実利用可否は最初のgenerationで確定します。

次に:

1. Autopilot `force=true / dry_run=true`
2. 1件の実投稿
3. Metrics Collector確認
4. `approval` で短期間運用
5. 問題なければ `auto`

## 4. 内蔵画像生成

静止画は `OPENAI_API_KEY` だけで生成可能です。

```text
OpenAI Image API
  ↓
GitHub Release: sns-ai-media
  ↓
public browser_download_url
  ↓
X / Instagram
```

同一slot + promptはRelease asset名が決定論的なので、Workflow retry時は既存assetを再利用します。

公開GitHub repository向けです。Privateへ変更した場合は `media.endpoint` で外部CDNを用意してください。Reel/動画も外部media sourceが必要です。

週次Maintenanceが古いassetを削除します。

## 5. Readiness / Current Report

**SNS Health Report**:

- `data/reports/readiness.json`
- `data/reports/readiness.md`

**Current Report**:

- `data/reports/latest.json`
- `data/reports/latest.md`

Current Reportには、投稿成績、学習strategy、trend、Web出典、A/B実験、API利用量、Circuit、直近error等を集約します。

## 6. 人間フィードバック

保存先:

```text
data/human-feedback.jsonl
```

Action:

- `prefer`
- `avoid`
- `correct`
- `pin`
- `note`

Issue title:

```text
[feedback] account-id
```

Body:

```json
{
  "account": "account-id",
  "action": "avoid",
  "note": "この方向は使わない",
  "dimension": "hook",
  "source": "chatgpt"
}
```

所有者または `SNS_COMMAND_ADMINS` のユーザーだけ処理できます。

## 7. 優先順位

1. identity / explicit instructions / safety
2. human feedback
3. factual / platform constraints
4. learned strategy
5. experiments / trend

反応が良くても、人間が禁止した方向へ自動最適化しません。

## 8. A/B実験

Daily Learningが十分なdataを検出するとexperimentを開始します。

- hook
- format
- CTA
- mediaDecision

通常の投稿slotをvariantへ割り当てるので、実験だけを理由に投稿数を増やしません。最低sample未満ではwinnerを決めません。

状態:

```text
data/experiments/<account>.json
```

## 9. Adaptive Schedule

AIが任意時刻を作ることは禁止しています。

```json
"schedule": {
  "times": ["08:00", "20:00"],
  "adaptiveCandidateTimes": ["08:00", "12:00", "18:00", "20:00"]
}
```

confidenceが基準を超えた後、許可済みcandidate内から既存slot数と同じ数だけ選びます。

## 10. Circuit Breaker

対象:

- autopilot
- publish
- analytics
- research

既定は連続3失敗 → 60分open。open中はAPIを叩かず、cooldown後の定期runから自動復帰を試します。

状態:

```text
data/runtime-health.json
```

## 11. 利用量上限

対象:

- OpenAI text/moderation calls
- Web Search calls
- external media calls
- image generations

保存:

```text
data/usage.jsonl
```

上限に達した処理は `BUDGET_EXHAUSTED` として安全に停止し、日付が変われば再開します。

## 12. 安全表記・リンク制約

`safety` で必須表記、広告表記候補、リンク数、allowlist/blocklist等をアカウント単位設定できます。これはAI投稿だけでなくmanual publishingにも適用されます。

## 13. Web情報の根拠

Web Searchを使ったResponsesから取得できたURL citationを保存します。

- trend: `data/trends/<account>.json`
- published post: `data/history.jsonl`

後から「この情報の根拠は？」を追跡できます。

## 14. 長期データ保守

**SNS Maintenance** が週次実行:

- history / metrics / usage / audit の重複除去
- 保存期間超過のraw rowを `data/archive/monthly-summary.json` へcount集約
- broken JSONLを `data/quarantine/invalid-jsonl.jsonl` へ隔離
- quarantine自体も期限整理
- stale approval Issueを自動close
- old generated image assetsを削除
- reports再生成

人間フィードバックは自動削除しません。

## 15. CI

**SNS-AI CI** はPR / main pushで:

- unit/integration tests
- config validation
- all source syntax checks
- keyless smoke
- secret scan
- 全Workflow YAML parse
- key-safe doctor

を実行します。

## 16. Workflow Failure Watch

主要Workflowが失敗すると:

```text
[health] <workflow> failure
```

Issueを1件だけ維持します。同一障害でIssueを増殖させず、後続runが成功すると自動Closeします。

## 17. ChatGPTから確認するとき

GitHub上の実記録を読み、例えば次を回答できます。

- 現在状態 / readiness
- 最近の投稿・成績
- 学習した勝ち筋 / 弱い型
- trend / source
- active/completed experiments
- current API usage
- circuit status
- recent errors
- human feedback
- なぜその投稿・画像を選んだか

## 18. 障害時の確認順

1. `[health]` Issue
2. `data/reports/readiness.md`
3. `data/reports/latest.md`
4. Actions run
5. Circuit state
6. daily usage budget
7. Live Preflight
8. platform permission / token expiry
9. media hosting / external endpoint

Secretsの実値をIssueやログへ貼らないでください。
