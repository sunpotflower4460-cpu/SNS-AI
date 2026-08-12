# SNS-AI

GitHub Actions を投稿エンジンにして、**複数の X / Instagram アカウント**を1つのリポジトリから扱うための最小基盤です。

## できること

- X: テキスト投稿 / 画像付き投稿
- Instagram: 画像投稿 / Reel 投稿
- 複数アカウントを `config/accounts.json` で管理
- 認証情報は GitHub Secret `SOCIAL_CREDENTIALS_JSON` に集約
- GitHub Actions の手動実行から投稿
- `[publish]` Issue を作るだけで投稿（ChatGPT → GitHub → SNS の橋として利用可能）
- `dryRun` で実投稿せず検証

> 現在の X 実装は画像メディアまでです。動画/GIFは chunked upload を追加する予定です。

## 1. アカウント設定

`config/accounts.json` に公開情報だけを追加します。

```json
{
  "accounts": {
    "sui-x": {
      "platform": "x",
      "enabled": true,
      "credentialKey": "sui-x",
      "displayName": "すい / X"
    },
    "sui-instagram": {
      "platform": "instagram",
      "enabled": true,
      "credentialKey": "sui-instagram",
      "displayName": "すい / Instagram",
      "apiVersion": "v23.0"
    }
  }
}
```

## 2. GitHub Secret

Repository Settings → Secrets and variables → Actions → New repository secret で、

- Name: `SOCIAL_CREDENTIALS_JSON`
- Value: 下記形式のJSON

```json
{
  "sui-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "..."
  },
  "sui-instagram": {
    "accessToken": "...",
    "igUserId": "..."
  }
}
```

このJSONをリポジトリのファイルとしてコミットしないでください。

### X 側

X Developer Console で App を用意し、投稿対象ユーザーの User Context credentials を取得します。この実装は長期自動運用しやすい OAuth 1.0a User Context を使用します。

### Instagram 側

Instagram Professional（Business / Creator）アカウントと Meta App が必要です。Instagram Login を使う場合、少なくとも `instagram_business_basic` と `instagram_business_content_publish` を付与したアクセストークンを使います。

Instagram の Publishing API は Meta 側から `mediaUrl` を取得するため、画像/動画は **外部からアクセスできる HTTPS URL** に置く必要があります。

## 3. GitHub Actions から投稿

Actions → **Publish social post** → Run workflow。

最初は必ず `dry_run=true` で検証してください。成功したら `false` に切り替えます。

## 4. ChatGPT から投稿するための Issue コマンド

Issue title を次の形式にします。

```text
[publish] sui-x
```

Issue body は JSON のみです。

### X テキスト投稿

```json
{
  "account": "sui-x",
  "text": "テスト投稿です",
  "dryRun": true
}
```

### X 画像付き

```json
{
  "account": "sui-x",
  "text": "画像付きテスト",
  "mediaUrl": "https://example.com/image.jpg",
  "dryRun": true
}
```

### Instagram 画像投稿

```json
{
  "account": "sui-instagram",
  "text": "Instagram caption",
  "mediaUrl": "https://example.com/image.jpg",
  "mediaType": "image",
  "dryRun": true
}
```

### Instagram Reel

```json
{
  "account": "sui-instagram",
  "text": "Reel caption",
  "mediaUrl": "https://example.com/video.mp4",
  "mediaType": "reel",
  "dryRun": true
}
```

Issue からの投稿が成功すると Actions が成功コメントを残して Issue を閉じます。失敗した場合は Issue を残し、Actions ログを確認できるようにします。

## セキュリティ

このリポジトリは Public です。`[publish]` Issue の本文も公開されるため、**投稿前の文章を非公開にしておきたい運用では Private リポジトリに変更**してください。APIキー・アクセストークンは Issue / config / README に絶対に書かず、GitHub Secret にのみ保存してください。

## ローカル検証

```bash
npm test
SOCIAL_CREDENTIALS_JSON='{"...":"..."}' node src/publish.mjs --json '{"account":"sui-x","text":"hello","dryRun":true}'
```
