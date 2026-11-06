// 行を歌うときの音の数（拍）を数える（別スレッドで動かす。js/mora.js から使う）。
//
// 形態素解析（kuromoji.js と IPA 辞書）で漢字の読みを文脈から決め、カタカナの読みにしてから拍を数える。
// 辞書は十数 MB あるので、画面を止めないよう別スレッドで読み込む。
//
// 拍の数え方: かな 1 文字を 1 拍。小さい「ゃゅょぁぃぅぇぉゎ」は前の文字とまとめて 1 拍。
// 「っ」「ん」「ー」はそれぞれ 1 拍。辞書に無い英語は母音のまとまりの数。
// 数（2026・二十 など）は位取りして読み（にせんにじゅうろく）、辞書は数と助数詞を別々に読むので、
// 読みが変わる組み合わせ（1人＝ひとり、3日＝みっか、20歳＝はたち など）は別に数える。

/* global kuromoji */
importScripts('../vendor/kuromoji/kuromoji.js');

let tokenizer = null;
const waiting = [];

kuromoji.builder({ dicPath: '../vendor/kuromoji/dict/' }).build((err, t) => {
  if (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
    return;
  }
  tokenizer = t;
  postMessage({ type: 'ready' });
  for (const msg of waiting.splice(0)) handle(msg);
});

onmessage = (e) => {
  if (tokenizer) handle(e.data);
  else waiting.push(e.data);
};

function handle(msg) {
  postMessage({ type: 'counts', lines: msg.lines, counts: msg.lines.map(countLine) });
}

const SMALL = new Set([...'ァィゥェォャュョヮ']);
const DIGIT_MORA = [2, 2, 1, 2, 2, 1, 2, 2, 2, 2];   // ゼロ イチ ニ サン ヨン ゴ ロク ナナ ハチ キュウ

/** かな（ひらがな・カタカナ）の拍の数。かな以外は数えない */
function kanaMora(s) {
  let n = 0;
  for (const ch of s) {
    let c = ch.codePointAt(0);
    if (c >= 0x3041 && c <= 0x3096) c += 0x60;   // ひらがな → カタカナ
    const k = String.fromCodePoint(c);
    if (SMALL.has(k)) continue;
    if ((c >= 0x30a1 && c <= 0x30fa) || k === 'ー') n++;
  }
  return n;
}

/** 英単語のおおよその音節の数（母音のまとまり。語末の黙字 e は数えない） */
function englishMora(word) {
  const w = word.toLowerCase();
  let n = (w.match(/[aeiouy]+/g) || []).length;
  if (n > 1 && /[^aeiouy]e$/.test(w) && !/le$/.test(w)) n--;
  return Math.max(1, n);
}

/** 辞書に読みが無い語の拍の数 */
function surfaceMora(s) {
  s = s.normalize('NFKC');
  let n = kanaMora(s);
  for (const w of s.match(/[a-z]+(?:'[a-z]+)?/gi) || []) n += englishMora(w);
  for (const d of s.match(/[0-9]/g) || []) n += DIGIT_MORA[+d];
  return n;
}

const KANJI_DIGIT = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const KANJI_UNIT = { '十': 10, '百': 100, '千': 1000 };
const KANJI_BIG = { '万': 1e4, '億': 1e8 };

/** 数の文字列（2026・２０２６・二千二十六・二〇二六）の値。読めなければ NaN */
function numberValue(s) {
  s = s.normalize('NFKC');
  if (/^[0-9]+$/.test(s)) return Number(s);
  if (/^[〇零一二三四五六七八九]+$/.test(s)) return Number([...s].map((c) => KANJI_DIGIT[c]).join(''));
  let total = 0;
  let group = 0;
  let digit = -1;
  for (const c of s) {
    if (c in KANJI_DIGIT) digit = KANJI_DIGIT[c];
    else if (c in KANJI_UNIT) {
      group += (digit < 0 ? 1 : digit) * KANJI_UNIT[c];
      digit = -1;
    } else if (c in KANJI_BIG) {
      total += (group + Math.max(digit, 0) || 1) * KANJI_BIG[c];
      group = 0;
      digit = -1;
    } else return NaN;
  }
  return total + group + Math.max(digit, 0);
}

/** 数を読んだときの拍の数（2026 → にせんにじゅうろく → 8）。
 *  促音や濁音になっても（いっせん・さんびゃく）拍の数は変わらない */
function numberMora(v) {
  if (v === 0) return 2;   // ゼロ
  if (!Number.isSafeInteger(v) || v >= 1e12) return NaN;
  const D = DIGIT_MORA;
  const group = (g) => {
    let m = 0;
    for (const [unit, place] of [[1000, 2], [100, 2], [10, 2]]) {
      const d = Math.floor(g / unit) % 10;
      if (d) m += (d === 1 ? 0 : D[d]) + place;   // 「いちせん」ではなく「せん」
    }
    return g % 10 ? m + D[g % 10] : m;
  };
  let m = 0;
  for (const [unit, place] of [[1e8, 2], [1e4, 2], [1, 0]]) {   // おく・まん
    const g = Math.floor(v / unit) % 1e4;
    if (g) m += group(g) + place;
  }
  return m;
}

/** 数と助数詞を合わせると読みが変わるものの拍の数（ひとり・ふたり・よにん・みっか・はたち など） */
const SPECIAL = {
  '人': { 1: 3, 2: 3, 4: 3 },
  '日': { 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 10: 3, 14: 5, 20: 3, 24: 5 },
  '歳': { 20: 3 },
  '才': { 20: 3 },
};

/** トークンの拍の数 */
function tokenMora(t) {
  const r = t.reading;
  return r && r !== '*' && kanaMora(r) > 0 ? kanaMora(r) : surfaceMora(t.surface_form);
}

/** 1 行の拍の数。空の行や [Verse] のような見出しの行は null（数を出さない） */
function countLine(line) {
  const s = line.trim();
  if (s === '' || /^[\[【].*[\]】]$/.test(s)) return null;
  const tokens = tokenizer.tokenize(s);
  let n = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].pos_detail_1 !== '数') {
      n += tokenMora(tokens[i]);
      continue;
    }
    // 続いている数をまとめて読む（二 / 十 / 歳 のように辞書は 1 字ずつに分けることがある）
    let j = i;
    let text = '';
    while (j < tokens.length && tokens[j].pos_detail_1 === '数') text += tokens[j++].surface_form;
    const v = numberValue(text);
    const next = tokens[j]?.surface_form;
    if (next in SPECIAL && SPECIAL[next][v]) {
      n += SPECIAL[next][v];
      j++;
    } else {
      const m = numberMora(v);
      n += Number.isNaN(m) ? tokens.slice(i, j).reduce((a, t) => a + tokenMora(t), 0) : m;
    }
    i = j - 1;
  }
  return n;
}
