# SNS-AI Operations

この文書は、初回開通・長期無人運用・障害・人間フィードバック・安全停止の運用手順です。

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

- `check` — `src/**/*.mjs`を自動発見して全構文確認
- `smoke` — 外部APIなしで主要ロジックを合成データ検証
- `secret-scan` — ソース・設定・Workflow・docs内の典型的秘密情報を検出
- `doctor` — Secret値を表示せず、設定・credential・media準備・任意`expiresAt`を確認

## 2. Secrets / Variables

必須（自律生成を使う通常構成）:

- `OPENAI_API_KEY`
- `SOCIAL_CREDENTIALS_JSON`

Xの通常テキスト/画像投稿はOAuth1 user credentialsを使います。X動画を使うアカウントだけ、同じcredential entryへ`oauth2AccessToken`（OAuth 2.0 user access token）を追加してください。

```json
{
  "my-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "...",
    "oauth2AccessToken": "... X動画利用時のみ ..."
  }
}
```

外部media endpoint使用時のみ:

- `MEDIA_SERVICE_TOKEN`

任意Variables:

- `OPENAI_MODEL`
- `SNS_COMMAND_ADMINS`
- `APPROVAL_MAX_AGE_DAYS`

鍵はIssue / README / configへ貼らないでください。

## 3. Live Preflight

Actions → **SNS Live Preflight**。

実投稿や有料media生成を行わず次を確認します。

- 必要な場合のOpenAI API認証
- X OAuth1 `/2/users/me`
- X動画アカウントではOAuth2 `/2/users/me`も確認し、OAuth1と同じXユーザーか照合
- Instagram対象アカウント読取
- 内蔵画像/Reel hostingを使う場合、GitHub repositoryがpublicか

Image / Video modelの実利用可否は最初の実generationで確定します。Preflightは確認目的だけで画像・動画を生成しません。

初回推奨順:

1. `pause`または`approval`で実アカウント登録
2. Live Preflight
3. Autopilot `force=true / dry_run=true`
4. 1件の実投稿
5. Metrics Collector確認
6. 短期間`approval`
7. 問題なければ`auto`

## 4. 内蔵画像 / Reel生成

### Image

```text
OpenAI Image API
  ↓
Moderation + Visual QA
  ↓ pass only
GitHub Release: sns-ai-media
  ↓
X / Instagram
```

### Reel / Video

```text
OpenAI Video API
  ↓ completed
spritesheet取得
  ↓ (取得不可ならthumbnail)
Moderation + Visual QA
  ↓ pass only
MP4取得
  ↓
GitHub Release: sns-ai-media
  ├→ Instagram Reel
  └→ X chunked upload
```

X動画はv2 media uploadの`initialize → append → finalize → status`を使い、processing完了後の`media_id`をPostへ添付します。

QA不合格時は、QAが明示した問題だけを元promptへ追記して、設定された`maxRegenerations`内で再生成します。不合格素材はReleaseへuploadしません。QA合格後はOpenAI側のcompleted video jobをbest-effortで削除します。

公開GitHub repository向けです。Privateへ変更する場合は`media.endpoint`などで外部public CDNを用意してください。

週次Maintenanceが古い生成media assetを削除します。

## 5. X alt text

画像QAから生成した客観的alt textを、Xではmedia upload後のmetadataへ登録してから投稿します。alt textは投稿履歴にも保存します。

X動画のQA説明文とInstagramの生成alt textは、未確認のAPI parameterを推測して送らず、履歴/監査情報として保持します。

## 6. Readiness / Current Report

**SNS Health Report**:

- `data/reports/readiness.json`
- `data/reports/readiness.md`

**Current Report**:

- `data/reports/latest.json`
- `data/reports/latest.md`

Current Reportには投稿成績、strategy、trend、source、A/B実験、API利用量、Circuit、media QA、安全ブレーキ、直近error等を集約します。

## 7. 人間フィードバック

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

所有者または`SNS_COMMAND_ADMINS`のユーザーだけ処理できます。

## 8. 優先順位

1. identity / explicit instructions / safety
2. human feedback
3. factual / platform constraints
4. learned strategy
5. experiments / trend

数字が良くても、人間が禁止した方向へ自動最適化しません。

## 9. A/B実験

Daily Learningが十分なdataを検出すると、通常投稿slotの中で`hook / format / CTA / mediaDecision`を検証します。実験だけを理由に投稿数を増やさず、最低sample未満ではwinnerを決めません。

状態:

```text
data/experiments/<account>.json
```

## 10. Adaptive Schedule

```json
"schedule": {
  "times": ["08:00", "20:00"],
  "adaptiveCandidateTimes": ["08:00", "12:00", "18:00", "20:00"]
}
```

AIがcandidate外の任意時刻を作ることは禁止しています。

## 11. Circuit Breaker

対象:

- autopilot
- publish
- analytics
- research

既定は連続3失敗 → 60分open。open中は対象APIを叩かず、cooldown後の定期runから再試行します。

状態:

```text
data/runtime-health.json
```

## 12. 反応異常ブレーキ

Circuit Breakerは「API障害」用、Anomaly Brakeは「投稿反応の極端な異常」用です。

十分なbaseline / confidence / exposureを持つ成熟投稿だけを評価し、極端なperformance collapseや低score + conversation spikeを検出すると、新しいAutopilot生成を一時停止します。

状態:

```text
data/brakes.json
```

特徴:

- 少し伸びない程度ではopenしない
- 過去投稿を自動削除しない
- brake state保存エラーはMetrics API Circuitから分離
- cooldown後は自動close
- Current Reportに状態表示

## 13. 利用量上限

対象:

- OpenAI text / moderation / QA
- Web Search
- external media
- image generation
- video generation

保存:

```text
data/usage.jsonl
data/usage-state.json
```

上限に達すると`BUDGET_EXHAUSTED`として安全に停止し、日付更新後に再開します。

## 14. 安全表記・リンク制約

`safety`で必須表記、広告表記候補、リンク数、allowlist/blocklist等をアカウント単位設定できます。AI投稿だけでなくmanual publishingにも適用されます。

## 15. Web情報の根拠

Web Searchで取得できたURL citationを保存します。

- trend: `data/trends/<account>.json`
- published post: `data/history.jsonl`

後から「この情報の根拠は？」を追跡できます。

## 16. 長期データ保守

**SNS Maintenance**が週次実行:

- history / metrics / usage / auditの重複除去
- 保存期間超過raw rowの月次count集約
- broken JSONLのquarantine
- stale approval Issue close
- old generated media assets削除
- reports再生成

人間フィードバックは自動削除しません。

## 17. CI

**SNS-AI CI**はPR / main pushで次を実行します。

- unit/integration tests
- config validation
- all source syntax checks
- keyless smoke
- secret scan
- 全Workflow YAML parse
- key-safe doctor

## 18. Workflow Failure Watch

主要Workflowが失敗すると`[health] <workflow> failure` Issueを1件だけ維持します。同一障害でIssueを増殖させず、後続run成功時にcloseします。

## 19. ChatGPTから確認するとき

GitHub上の実記録から次を確認できます。

- readiness / current state
- 最近の投稿・成績
- 勝ち筋 / 弱い型
- trend / source
- A/B experiment
- API usage
- Circuit / anomaly brake
- media QA
- recent errors
- human feedback
- 投稿・画像/動画を選んだ理由

## 20. 障害時の確認順

1. `[health]` Issue
2. `data/reports/readiness.md`
3. `data/reports/latest.md`
4. Actions run
5. Anomaly Brake / Circuit state
6. daily usage budget
7. Live Preflight
8. platform permission / token expiry / X OAuth2 video token
9. media hosting / external endpoint

Secretsの実値をIssueやログへ貼らないでください。
