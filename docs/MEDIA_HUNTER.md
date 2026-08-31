# Media Hunter

Instagram のために毎回 AI 画像を生成する設計は使いません。投稿メディアは次の優先順位で探します。

1. ユーザー所有素材
2. 登録済み Asset Library
3. メーカー公式の対象製品素材
4. 公式 Press Kit
5. 公式 GitHub / release の対象製品画像
6. 利用条件が確認できる公式素材
7. ブランドカード（製品UIを描かない情報カード）
8. skip

AI 画像生成は製品画像の fallback にしません。

## Entity verification（fail closed）

紹介対象 entity と画像 entity が一致しない限り、製品画像として採用しません。

保持する情報: `entityName`, `vendor`, `canonicalUrl`, `sourceUrl`, `mediaUrl`, `mediaSourceType`, `evidenceUrls`, `verificationStatus`, `verificationConfidence`, `license` / usage note。

`verificationStatus` が `verified` でない画像は製品画像になりません。曖昧なら reject。

### プラットフォーム

- **X**: 画像なし投稿を許可
- **Instagram**: verified product image → verified brand/vendor visual → テキスト中心ブランドカード → skip

「それっぽい偽画像」で Instagram を成立させません。

## ブランドカード

SVG の情報カードです。架空プラグインUI・製品外観の想像・公式ロゴ改変はしません。
LIVE の Instagram 投稿には hosted raster URL が必要なため、カードをホストできない場合は skip します。

## 利用根拠

`usageBasis`: `owned` / `official_press_asset` / `official_product_asset` / `licensed` / `unknown`。
`unknown` は Instagram へ自動採用しません。取得元 `sourceUrl` / `assetUrl` / `retrievedAt` を残します。

設定: `config/media-policy.json`。
