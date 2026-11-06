// 行を歌うときの音の数（拍）を数える（別スレッドで動かす。js/mora.js から使う）。
//
// 形態素解析（kuromoji.js と IPA 辞書）で漢字の読みを文脈から決め、カタカナの読みにしてから拍を数える。
// 辞書は十数 MB あるので、画面を止めないよう別スレッドで読み込む。
//
// 拍の数え方: かな 1 文字を 1 拍。小さい「ゃゅょぁぃぅぇぉゎ」は前の文字とまとめて 1 拍。
// 「っ」「ん」「ー」はそれぞれ 1 拍。辞書に無い英語は母音のまとまりの数、数字は 1 けたずつ読む。

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

/** 1 行の拍の数。空の行や [Verse] のような見出しの行は null（数を出さない） */
function countLine(line) {
  const s = line.trim();
  if (s === '' || /^[\[【].*[\]】]$/.test(s)) return null;
  let n = 0;
  for (const t of tokenizer.tokenize(s)) {
    const r = t.reading;
    n += r && r !== '*' && kanaMora(r) > 0 ? kanaMora(r) : surfaceMora(t.surface_form);
  }
  return n;
}
