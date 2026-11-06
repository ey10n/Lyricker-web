// 右のノートの各行を歌うときの音の数（拍）。計算は別スレッド（js/mora-worker.js）で行い、
// 行の文字列ごとに結果を覚えておく（書き換えた行だけ数え直す）。

let worker = null;
let state = 'idle';          // idle / loading / ready / error
const cache = new Map();     // 行の文字列 → 拍の数（数えない行は null）
const pending = new Set();   // 数えている途中の行
let onUpdate = () => {};

/** 辞書の読み込みを始める。数え終わるたびと、状態が変わったときに update() を呼ぶ */
export function initMora(update) {
  onUpdate = update;
  if (worker) return;
  state = 'loading';
  try {
    worker = new Worker(new URL('./mora-worker.js', import.meta.url));
  } catch {
    state = 'error';
    return;
  }
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') state = 'ready';
    else if (m.type === 'error') state = 'error';
    else if (m.type === 'counts') {
      m.lines.forEach((line, i) => {
        cache.set(line, m.counts[i]);
        pending.delete(line);
      });
    }
    onUpdate();
  };
  worker.onerror = () => {
    state = 'error';
    onUpdate();
  };
}

export function moraState() {
  return state;
}

/** 各行の拍の数。まだ数えていない行は undefined（数え終わったら update() が呼ばれる） */
export function moraCounts(lines) {
  const ask = [];
  const out = lines.map((line) => {
    if (cache.has(line)) return cache.get(line);
    if (!pending.has(line) && worker && state !== 'error') {
      pending.add(line);
      ask.push(line);
    }
    return undefined;
  });
  if (ask.length) worker.postMessage({ lines: ask });
  // 覚えておく行が増えすぎたら捨てる（今の行はまた数え直す）
  if (cache.size > 5000) cache.clear();
  return out;
}
