// AI への指示（プロンプト）を名前を付けて保存しておく一覧。
// 初回（まだ保存が無いとき）は、よく使いそうな指示をいくつか入れておく。

import * as store from './store.js';

const DEFAULTS = [
  {
    name: '誤字・脱字の修正',
    text: '次の歌詞の誤字・脱字を修正してください。\n' +
      '修正後の歌詞全文だけを出力し、説明や前置きは書かないでください。\n' +
      '行の数と順番、改行の位置は変えないでください。',
  },
  {
    name: '表記の統一',
    text: '次の歌詞の表記ゆれ（漢字・ひらがな・カタカナ、送り仮名、記号）を統一してください。\n' +
      '修正後の歌詞全文だけを出力し、説明や前置きは書かないでください。\n' +
      '行の数と順番は変えないでください。',
  },
  {
    name: '問題点の指摘',
    text: '次の歌詞について、誤字・脱字や不自然な表現があれば、' +
      '行番号・該当箇所・修正案を箇条書きで挙げてください。',
  },
];

export function loadPrompts() {
  const list = store.load('prompts', null);
  if (Array.isArray(list)) {
    return list.filter((p) => p && typeof p.name === 'string' && typeof p.text === 'string');
  }
  return DEFAULTS.map((p) => ({ ...p }));
}

export function savePrompts(list) {
  return store.save('prompts', list);
}
