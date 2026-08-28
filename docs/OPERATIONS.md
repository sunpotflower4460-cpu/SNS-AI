# SNS-AI Operations

この文書は、**実接続 → controlled launch → 定期自動投稿 → 長期無人運用 → 障害対応**の手順です。

**現在このリポジトリはManual-Onlyでロックされています**（[`docs/MANUAL_ONLY_MODE.md`](MANUAL_ONLY_MODE.md)）。§7「定期自動投稿」と§11「Metrics / Learning」が説明するschedule実行、および§16末尾の「定期実行」は、Manual-Onlyを別途レビューして解除した場合の設計上の挙動です。現在は全てのSNS操作workflowが`workflow_dispatch`のみで、schedule triggerは付いていません。実際の手動実行手順は[`docs/MANUAL_SETUP_CHECKLIST.md`](MANUAL_SETUP_CHECKLIST.md)を参照してください。

## 1. 接続前にCIが保証する範囲

PR / main CIで次を実行します。

```bash
npm test
npm run validate
npm run check
npm run smoke
npm run secret-scan
npm run doctor
npm run report
npm run weekly-report
npm run maintenance
```

外部Secretや有料generationを使わず、unit/integration、設定、全source構文、全Workflow YAML、report/maintenance runtimeまで確認します。

## 2. 実接続に必要なもの

### OpenAI

- `OPENAI_API_KEY`
- OpenAI API billing / credits
- 設定するtext / image / video / QA modelへのaccess

既定:

- text / QA: `gpt-5`
- image: `gpt-image-2`
- video: `sora-2`（**OpenAI Videos APIは2026-09-24に終了**。既定の`internalVideoGeneration`は`false`）

Live Preflightは`/v1/models/{model}`でmodel availabilityを確認します。Image / Video endpointの最終proofは最初のcontrolled generationです。

### X — text only

`SOCIAL_CREDENTIALS_JSON`内にOAuth1 user credentials:

```json
{
  "my-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "..."
  }
}
```

### X — image / videoを使う場合

上記OAuth1に加えてOAuth2 authorizationを用意します。

必須scope:

- `tweet.write`
- `users.read`
- `media.write`
- `offline.access`

credential entry:

```json
{
  "my-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "...",
    "oauth2ClientId": "...",
    "oauth2RefreshToken": "... offline.accessで取得 ...",
    "oauth2AccessToken": "... optional current token ...",
    "oauth2ExpiresAt": "... optional ISO date ...",
    "oauth2Scope": "tweet.write users.read media.write offline.access"
  }
}
```

confidential clientの場合は任意で`oauth2ClientSecret`も指定できます。

さらにRepository Secret:

- `X_OAUTH2_STATE_KEY` — 32文字以上のランダム秘密値

初回Preflightでrefresh tokenからOAuth2 sessionをbootstrapします。以降、access token期限接近または401時に自動refreshし、rotating access/refresh tokenをAES-256-GCMで暗号化した`data/x-oauth2-state.json`として保存します。

**`X_OAUTH2_STATE_KEY`は長期保持してください。** この鍵を失う/変更すると既存stateを復号できません。その場合はX OAuth2を再authorizationし、新しいrefresh tokenでPreflightをやり直します。

### Instagram

- Instagram Professional account（Business / Creator）
- Instagram Loginで得たaccess token
- Instagram Professional account ID (`igUserId`)
- 少なくとも投稿に必要な権限（`instagram_business_basic`, `instagram_business_content_publish`）
- Metrics利用時は対象Insightsを読める権限

credential example:

```json
{
  "my-instagram": {
    "accessToken": "...",
    "igUserId": "...",
    "expiresAt": "2027-01-01T00:00:00Z"
  }
}
```

既定API versionは`v25.0`。投稿container create/publishはmultipart formで送ります。

Instagram tokenについては、リポジトリは`expiresAt`を監視して期限切れ/14日以内を警告します。X OAuth2のようなtoken refreshを現在は推測実装していないため、利用するMeta tokenのライフサイクルに合わせて更新してください。

## 3. GitHub側のSecrets

通常構成:

- `OPENAI_API_KEY`
- `SOCIAL_CREDENTIALS_JSON`

X image / video利用時:

- `X_OAUTH2_STATE_KEY`

外部media endpoint利用時のみ:

- `MEDIA_SERVICE_TOKEN`

Secret値をIssue、README、config、Actions logへ貼らないでください。

## 4. 実アカウントconfig

最初は`enabled: true`かつ`mode: approval`を推奨します。

最低限定義するもの:

- `platform`
- `credentialKey`
- identity / goal / audience
- topics / style / avoid
- account固有instructions
- schedule timezone / days / times / windowMinutes
- generation maxChars
- media strategy / type
- safety / disclosure / domain rules（必要な場合）

`auto`へ上げる前に、identityや禁止事項を空欄のままにしないでください。

## 5. Live Preflight

Actions → **SNS Live Preflight**。

投稿や有料image/video generationをせず次を確認します。

- Secret shape
- OpenAI Moderation API認証
- configured OpenAI model availability
- X OAuth1 identity
- X media利用時のOAuth2 refresh bootstrap
- X OAuth1/OAuth2が同一ユーザーか
- OAuth2 scope metadataがある場合の必須scope
- Instagram Professional account identity
- built-in media hosting時のGitHub repository public状態

Preflight中にX tokenがrotateした場合、その暗号化stateは成功/失敗にかかわらず保存を試みます。

## 6. Controlled launch

次の順番を崩さないことを推奨します。

1. 実アカウントを`approval`
2. Live Preflight成功
3. SNS Autopilotを`force=true / dry_run=true`
4. 生成内容・media判断・安全checkを確認
5. built-in image/videoを使う場合は最初のcontrolled generation
6. approval経由で1件だけ実投稿
7. 投稿URL/IDがhistoryへ保存されたことを確認
8. SNS Metrics Collectorを確認
9. Current Reportでmetricsが反映されることを確認
10. 問題なければ`mode: auto`（Manual-Only下では`account-control.yml`経由での`auto`遷移は拒否されます。到達するには`config/accounts.json`への別途レビュー済みの直接編集が必要です）

## 7. 定期自動投稿（Manual-Only解除後の設計）

**この節はManual-Onlyを別途レビューして解除し、scheduleを再導入した場合の設計です。現在**SNS Autopilot**は`workflow_dispatch`のみで、10分ごとには起動しません。** 解除後は、`findDueSlots()`がアカウントtimezoneの`times`と`windowMinutes`を見て対象slotを拾う設計です。

同じslotは`account:date:time`のslot IDでstate管理するため、同一slotを再投稿しない設計です。

GitHub Actions scheduleはhard real-timeではないため、時刻ぴったりを保証するのではなく`windowMinutes`内で拾う方式です。通常は30分windowを推奨します。

## 8. X OAuth2長期運用

X media requestの前に暗号化stateを読みます。

- access tokenが有効 → そのまま使用
- 期限5分以内 → refresh
- APIが401 → 1回refreshして再試行
- refresh成功 → 新しいaccess/refresh tokenを暗号化stateへ保存

Autopilotは`data/`を`always()`でpersistします。Publish / Preflightもtoken rotationが発生した場合に後続stepが失敗してもstate保存を試みます。

## 9. Instagram media処理

投稿は次の順です。

```text
multipart /media container create
  ↓
status_code poll
  ↓ FINISHED
multipart /media_publish
```

画像は`image_url`、Reelは`video_url + media_type=REELS`。container processingは既定最大5分待ちます。

## 10. 内蔵Image / Video生成

### Image

```text
OpenAI Image API (gpt-image-2)
  ↓
Moderation + Visual QA
  ↓ pass only
GitHub Release
  ↓
X / Instagram
```

### Video

```text
OpenAI Video API multipart create (sora-2)
  ↓
poll completed
  ↓
spritesheet QA (fallback thumbnail)
  ↓ pass only
MP4 download
  ↓
GitHub Release
  ├→ Instagram Reel
  └→ X v2 chunked media upload
```

QA不合格素材はReleaseへ公開しません。設定回数内でQA指摘だけを反映して再生成します。

## 11. Metrics / Learning（Manual-Only解除後の設計）

**この節もManual-Only解除後のscheduleを前提とした設計です。現在はいずれも`workflow_dispatch`による手動実行のみです。** 解除後の想定cadence:

- Metrics Collector: 毎時
- Daily Learning: 毎日
- Trend Intelligence: 6時間ごと（enabled時）
- Health Report: 毎日
- Maintenance: 週次

Metricsは投稿historyのproviderPostIdを基準にcheckpoint収集し、学習は成熟データからstrategyを更新します。

## 12. 安全停止

### Circuit Breaker

API障害用。既定は連続3失敗 → 60分open → cooldown後に再試行。

### Anomaly Brake

反応異常用。十分なbaseline/confidence/exposureがある成熟投稿だけを対象に、極端なcollapse等で新しいAutopilot生成を一時停止します。過去投稿は削除しません。

## 13. 利用量 / billing

リポジトリ内hard cap:

- OpenAI calls
- Web Search calls
- Groq calls（`research.directFetch: true`のアカウントのみ）
- external media calls
- image generations
- video generations

provider側のbilling/credits/rate limitは別です。X API creditsとOpenAI API billing/creditsが有効である必要があります。Groqは任意（`GROQ_API_KEY`未設定時は自動的にOpenAIへfallback）です。

`research.directFetch: true`のアカウントは、Web Searchより先にRSS/GitHub Releasesなど無料の一次情報を直接取得し、既読済み情報を`data/research-cache/`でスキップしてから低コストAI（既定Groq）で評価します。Web Searchは直接取得だけでは情報が不足したときのfallbackとしてのみ呼ばれます。詳細: [`docs/LOW_COST_RESEARCH.md`](LOW_COST_RESEARCH.md)。`npm run cost-report`で「何にコストが発生しているか」（research fetch件数、AI呼び出し件数、X APIのURL付き/なし投稿数）を確認できます。

## 14. 主要state

- `data/history.jsonl`
- `data/metrics.jsonl`
- `data/strategies/<account>.json`
- `data/experiments/<account>.json`
- `data/human-feedback.jsonl`
- `data/usage.jsonl`
- `data/audit.jsonl`
- `data/runtime-health.json`
- `data/brakes.json`
- `data/x-oauth2-state.json`（暗号化token state）
- `data/reports/latest.json` / `.md`
- `data/reports/readiness.json` / `.md`

## 15. 障害時の確認順

1. `[health]` Issue
2. `data/reports/readiness.md`
3. `data/reports/latest.md`
4. Actions run
5. Circuit / Anomaly Brake
6. daily usage budget
7. Live Preflight
8. credential/token expiryまたはX OAuth2 refresh
9. X/OpenAI provider credits
10. media hosting / external endpoint

## 16. 「自動投稿できる」と判定する最終ゲート

次が全て成立したら`auto`へ移行できます。

- CI green
- Doctor `ready`
- Live Preflight `ready`
- dry-run success
- controlled generation success（media利用時）
- controlled real post success
- providerPostIdのhistory保存
- 1回以上のMetrics収集成功
- Health Issueなし

ここまで通った時点で完了するのは「1件の確認済みlive投稿」までです。`mode: auto`への遷移自体、Manual-Only下では`account-control.yml`経由で拒否されます。ここに書いた「残る定期実行はGitHub Actions + configured scheduleが担当」は、Manual-Onlyを別途レビューして解除した場合の設計であり、現在の挙動ではありません。
