// Prompt + response schema for the copy-draft step. The quality conditions below are mirrored by the
// deterministic checks in quality.mjs; keep the two in sync and bump PROMPT_VERSION in
// config/copy-drafts.json when either changes.

export function variantsSchema({ min, max }) {
  const str = { type: 'string' };
  return {
    type: 'object', additionalProperties: false, required: ['variants'], properties: {
      variants: {
        type: 'array', minItems: min, maxItems: max, items: {
          type: 'object', additionalProperties: false,
          required: ['angle', 'caption_jp', 'caption_en', 'youtube_title_jp', 'youtube_title_en', 'x_text', 'hashtags'],
          properties: {
            angle: str, caption_jp: str, caption_en: str, youtube_title_jp: str, youtube_title_en: str, x_text: str,
            hashtags: { type: 'array', minItems: 1, maxItems: 8, items: str }
          }
        }
      }
    }
  };
}

export function buildSystemPrompt({ min, max }) {
  return [
    'あなたはキャラクター系ショート動画/画像の投稿文案を作る日英コピーライターです。',
    `ブリーフ1件につき、互いに狙い(angle)が重ならない文案の候補を${min}〜${max}案、JSONだけで返してください。`,
    '候補は運用担当者が読み、選定・微修正して投稿します。あなたは投稿しません。',
    '',
    '# 各案の項目',
    '- angle: 案の狙いを一言で(例: オチ先行 / しみじみ / ギャグ寄り)。全案で互いに異なること。',
    '- caption_jp: Instagram / Threads / TikTok 共用の日本語キャプション。',
    '- caption_en: 同内容の英語キャプション。',
    '- youtube_title_jp / youtube_title_en: YouTube用タイトル(各100文字以内)。',
    '- x_text: X用テキスト。URLを含めない。ハッシュタグを含める場合も280字(日本語は1字2カウント換算で140字相当)に収め、投稿ボタンにそのまま入る形にする。',
    '- hashtags: "#"始まりの語の配列。先頭は #オリジナルキャラクター を基本にし、本編に合う語を足す。',
    '',
    '# 品質条件(必ず守る)',
    '1. 日本語キャプションは言い切り・体言止めを基本にする。「〜です」「〜のです」「〜ます」で終わる文を連続させない。',
    '2. 「ワールドクリエイターとしての、○○の世界。」のような定型の書き出しを使わない。',
    '3. 読者への問いかけ(?・「〜でしょうか」等)で締めるのは全案共通にしない。使ってよいのは全案のうち最大1案まで。',
    '4. 英語の固有名詞表記: さんぽっと = Sunpot (Sanpotto と書かない) / ひぐま = Higuma / マンドラごん = Mandoragon。英語欄に日本語表記を混ぜない。',
    '5. タイトル・キャプションは本編の内容だけから作る。動画末尾の共通エンドカード(ロゴ画面)は内容として扱わず、言及もしない。',
    '6. 事実にない設定・ストーリー・固有名・台詞・場所・背景事情を足さない。ブリーフの scene に書かれた範囲で書く。scene が短くても推測で膨らませない。',
    '7. x_text にリンク(URL)を含めない。',
    '8. 煽り・誇張・「必見」「衝撃」などの定型の釣り表現を避ける。',
    '9. 案ごとに「何を先頭に置くか・どの視点で語るか・語り口(状況描写 / オチ先行 / 擬音・ひとこと / 余韻)」を変え、同じ語や同じ文型を複数案の軸にしない。事実(scene)は同じでも、案ごとに書き出しの語と文の構成が明確に違うこと。',
    '',
    '# 出力',
    '指定スキーマのJSONのみ。説明文やコードフェンスは付けない。'
  ].join('\n');
}

export function buildUserPrompt(brief) {
  const lines = [
    `キャラクター: ${brief.character}`,
    `媒体: ${brief.media === 'video' ? '動画' : '画像'}`,
    `対象プラットフォーム: ${brief.platforms.join(', ')}`,
    '',
    '本編の内容(エンドカードの内容は含まれない):',
    brief.scene
  ];
  if (brief.notes) lines.push('', '補足(使いたい言い回し・避けたい表現など):', brief.notes);
  lines.push('', '注意: 上記の外側にある設定・ストーリーは足さないこと。');
  return lines.join('\n');
}
