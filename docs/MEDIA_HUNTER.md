# Media Hunter

Instagram のために毎回 AI 画像を生成する設計は使いません。

## 今できること / まだしないこと

**現行の既定パスは「候補選択」です。** 渡された candidate（owned / Asset Library URL / オペレーター登録素材）を優先順位で並べ、entity verification を通したものだけ採用します。オープンウェブを巡回して公式画像を自動探索済み、という意味ではありません。

公式ページの自動クロールは未接続が既定です。`media.acquireFromCanonical: true` かつ fetch adapter を渡したときだけ、**既知の canonical URL** から `og:image` 等を抽出します。抽出しても `usageBasis` は `unknown`、権利未確認のままです。Press kit / GitHub release の横断探索は V2 以降です。

優先順位（渡された candidate に対して）:

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
