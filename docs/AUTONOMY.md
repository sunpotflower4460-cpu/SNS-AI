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
10. 静止画のOpenAI Image API生成
11. 公開GitHub Release assetへの画像hosting
12. X / Instagram公式API投稿
13. 投稿後メトリクスの時間別収集
14. アカウント自身のbaselineとの相対評価
15. rolling windowでのstrategy更新
16. experiment winner判定と次experiment開始
17. current / weekly report生成
18. Web参照URL・判断理由・media経路・errorの監査記録
19. Circuit BreakerによるAPI障害時の自動休止/復帰
20. API種類別の日次利用hard cap
21. token期限metadataの警告
22. Workflow失敗Issueの作成・復旧Close
23. stale approval Issueの自動失効
24. data dedupe / retention / archive / quarantine
25. 古い生成画像assetの削除
26. official X / Instagram policy情報の定期監視とreview Issue作成
27. PR/main CI・全source構文・全workflow YAML・secret scan

## 自動改善が変更してよいもの

- topic/angleの配分
- hook
- format
- CTA
- media decision
- human-approved candidate内の投稿時間
- Explore/Exploitの実行結果
- experimentの次の対象dimension

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

## 自動化しない外部境界

次はSNS-AI単体では作れません。

1. X / Meta / OpenAIのAPIキー・OAuth tokenの発行
2. プラットフォーム側のdeveloper app審査・権限承認
3. 実在アカウントのidentity / goal / audience /禁止事項という最上位方針
4. 法律・契約・プラットフォーム規約の解釈が曖昧な場合の最終判断
5. Private repositoryでInstagram等に公開可能なmedia URLを出すための外部CDN契約/認証
6. Reel/動画を生成する外部video service（静止画生成は内蔵済み）
7. API提供者の障害・料金変更・サービス停止そのもの

Policy Watchは公式情報の変化を自動検出し、影響がありそうな場合はIssueを作りますが、**法的/規約上のhard ruleをAIだけで勝手に書き換えません**。

## 起動時の最後の人間作業

1. Secretsを登録
2. 実アカウント設定を登録
3. `SNS Live Preflight` を実行
4. `force=true / dry_run=true` を確認
5. 最初の実投稿を確認
6. 問題なければ `auto`

その後は、健康監視・調査・生成・投稿・分析・学習・実験・報告・保守が自動で循環します。
