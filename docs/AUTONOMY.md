# SNS-AI Autonomy Boundary

この文書は「SNS-AI自身に任せてよい範囲」と「外部認証・人間判断が必要な境界」を固定します。

## 完全自動で回す範囲

SNS-AIは、アカウントが有効化され必要な認証が揃った後、次を無人実行できます。

1. 定刻起動とアカウント選択
2. 最近の投稿・人間フィードバック・学習strategy読込
3. 必要なアカウントのWeb/Trend調査
4. 複数投稿案生成
5. 重複・安全・必須表記・リンク/ドメイン制約チェック
6. spread予測 + 過去実績 + Explore/Exploitによる候補選択
7. 通常投稿枠を使ったA/B実験
8. 人間が許可した候補内での投稿時間最適化
9. 画像なし / library / search / generate判断
10. OpenAI Image APIによる静止画生成
11. OpenAI Video APIによる短尺動画生成
12. 生成画像 / 動画spritesheet（fallback thumbnail）のModeration + 視覚QA
13. QA不合格時の問題限定prompt修正と自動再生成
14. QA合格素材だけを公開GitHub Release assetへhosting
15. QA時に生成したalt textの保存、X画像へのmedia metadata登録
16. X / Instagram公式API投稿
17. X media用OAuth2 access tokenの期限監視・refresh・暗号化state保存
18. 投稿後メトリクスの時間別収集
19. アカウント自身のbaselineとの相対評価
20. 十分なbaselineがある場合の極端な反応異常検知と一時AUTOブレーキ
21. ブレーキcooldown後の自動再開
22. rolling windowでのstrategy更新
23. experiment winner判定と次experiment開始
24. current / weekly report生成
25. Web参照URL・判断理由・media QA・media経路・errorの監査記録
26. Circuit BreakerによるAPI障害時の自動休止/復帰
27. API種類別の日次利用hard cap（画像/動画生成を含む）
28. credential期限metadataの警告
29. Workflow失敗Issueの作成・復旧Close
30. stale approval Issueの自動失効
31. data dedupe / retention / archive / quarantine
32. 古い生成media assetの削除
33. official X / Instagram policy情報の定期監視とreview Issue作成
34. PR/main CI・全source構文・全workflow YAML・secret scan・operational runtime checks

## 自動改善が変更してよいもの

- topic/angleの配分
- hook
- format
- CTA
- media decision
- human-approved candidate内の投稿時間
- Explore/Exploitの実行結果
- experimentの次の対象dimension
- QAで明示された視覚不具合を直すための生成prompt差分

## 自動改善が変更してはいけないもの

- account identity
- brand/personality
- explicit human instructions
- human feedback
- legal/compliance hard rules
- credential/permission scope
- safety rules
- 許可していない投稿時刻
- 許可していないSNSアカウント
- 反応が悪いという理由だけで過去投稿を自動削除すること

## 自動化しない外部境界

次はSNS-AI単体では作れません。

1. X / Meta / OpenAIのapp・API key・最初のOAuth authorization
2. X API credits / OpenAI API billing・credits
3. プラットフォーム側のdeveloper app審査・権限承認
4. 実在アカウントのidentity / goal / audience /禁止事項という最上位方針
5. 法律・契約・プラットフォーム規約の解釈が曖昧な場合の最終判断
6. Private repositoryでInstagram等に公開可能なmedia URLを出すための外部CDN契約/認証
7. API提供者の障害・料金変更・サービス停止そのもの
8. OpenAI側で対象image/video modelの利用権限が付与されていない場合のplatform-side access enablement
9. Instagram access token自体のprovider-defined lifecycle/rotation（Doctorは期限を警告するが、未確認のrefresh方式を推測実装しない）

静止画と標準的な短尺動画の生成自体は内蔵済みで、外部media serviceは必須ではありません。外部endpointは、独自素材検索・独自生成基盤・private repository用CDNなどを使いたい場合の任意拡張です。

X media用OAuth2は`offline.access` refresh tokenを人間が最初に取得した後、access/refresh token rotationを自動化します。`X_OAUTH2_STATE_KEY`を失った場合は暗号化stateを復号できないため、再authorizationが必要です。

Policy Watchは公式情報の変化を自動検出し、影響がありそうな場合はIssueを作りますが、**法的/規約上のhard ruleをAIだけで勝手に書き換えません**。

## 起動時の最後の人間作業

1. Secrets / provider creditsを準備
2. 実アカウント設定を`approval`で登録
3. `SNS Live Preflight` を実行
4. `force=true / dry_run=true` を確認
5. media利用時はcontrolled generationを確認
6. 最初の実投稿を1件確認
7. Metrics取得を確認
8. 問題なければ `auto`

その後は、健康監視・調査・生成・media QA・投稿・分析・安全ブレーキ・学習・実験・報告・保守が自動で循環します。
