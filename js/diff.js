// 左右の行の対応（アライメント）・行頭の印・再出行の判定。
//
// 共通する先頭・末尾を取り除いたうえで LCS（最長共通部分列）を求めるので、
// 行の挿入や削除があっても、ずれた行だけが差異として残る。
// 変更された行は左右 1 行ずつを 1 行として対応付け、片側にしか無い行は
// 相手側を -1（対応なし）として返す。

// LCS の作業表がこれを超える場合は計算をあきらめ、まとめて差異扱いにする
const MAX_DP_CELLS = 2000000;

const SAME = 0;
const LEFT_ONLY = 1;
const RIGHT_ONLY = 2;

/**
 * left / right（行の配列）を上から並べたときの対応表を返す。
 * 各要素は { left: 左の行番号 or -1, right: 右の行番号 or -1, same: 同じ内容か }
 */
export function computeLineAlignment(left, right) {
  const n = left.length;
  const m = right.length;
  const ops = [];

  // 一致している先頭部分
  let pre = 0;
  while (pre < n && pre < m && left[pre] === right[pre]) pre++;
  // 一致している末尾部分
  let suf = 0;
  while (suf < n - pre && suf < m - pre && left[n - 1 - suf] === right[m - 1 - suf]) suf++;

  for (let i = 0; i < pre; i++) ops.push([SAME, i, i]);

  const a = n - pre - suf; // 左側の比較対象行数
  const b = m - pre - suf; // 右側の比較対象行数
  if (a > 0 || b > 0) {
    if (a === 0) {
      for (let j = 0; j < b; j++) ops.push([RIGHT_ONLY, -1, pre + j]);
    } else if (b === 0) {
      for (let i = 0; i < a; i++) ops.push([LEFT_ONLY, pre + i, -1]);
    } else if (a * b > MAX_DP_CELLS) {
      for (let i = 0; i < a; i++) ops.push([LEFT_ONLY, pre + i, -1]);
      for (let j = 0; j < b; j++) ops.push([RIGHT_ONLY, -1, pre + j]);
    } else {
      // LCS の長さ表
      const w = b + 1;
      const c = new Int32Array((a + 1) * w);
      for (let i = 1; i <= a; i++) {
        for (let j = 1; j <= b; j++) {
          if (left[pre + i - 1] === right[pre + j - 1]) {
            c[i * w + j] = c[(i - 1) * w + j - 1] + 1;
          } else {
            c[i * w + j] = Math.max(c[(i - 1) * w + j], c[i * w + j - 1]);
          }
        }
      }
      // 逆にたどって操作列を作り、あとで反転する
      const rev = [];
      let i = a;
      let j = b;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && left[pre + i - 1] === right[pre + j - 1]) {
          rev.push([SAME, pre + i - 1, pre + j - 1]);
          i--;
          j--;
        } else if (j > 0 && (i === 0 || c[i * w + j - 1] >= c[(i - 1) * w + j])) {
          rev.push([RIGHT_ONLY, -1, pre + j - 1]);
          j--;
        } else {
          rev.push([LEFT_ONLY, pre + i - 1, -1]);
          i--;
        }
      }
      for (let k = rev.length - 1; k >= 0; k--) ops.push(rev[k]);
    }
  }

  for (let i = 0; i < suf; i++) ops.push([SAME, n - suf + i, m - suf + i]);

  // 操作列を左右 1 行ずつの対応表に変換する。
  // 連続する「左のみ」「右のみ」は 1 つの変更ブロックとして順に対応付ける。
  const rows = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === SAME) {
      rows.push({ left: ops[i][1], right: ops[i][2], same: true });
      i++;
      continue;
    }
    const dels = [];
    const ins = [];
    while (i < ops.length && ops[i][0] !== SAME) {
      if (ops[i][0] === LEFT_ONLY) dels.push(ops[i][1]);
      else ins.push(ops[i][2]);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, ins.length); k++) {
      rows.push({
        left: k < dels.length ? dels[k] : -1,
        right: k < ins.length ? ins[k] : -1,
        same: false,
      });
    }
  }
  return rows;
}

/**
 * 行頭の印。左には右で削除された行（'deleted'）、
 * 右には変更された行（'changed'）・左に無い行（'added'）を付ける。
 */
export function computeLineMarks(rows, rightCount) {
  const leftMarks = rows.map((r) => (r.right < 0 && r.left >= 0 ? 'deleted' : ''));
  const rightMarks = new Array(rightCount).fill('');
  for (const r of rows) {
    if (r.right < 0 || r.right >= rightCount || r.same) continue;
    rightMarks[r.right] = r.left < 0 ? 'added' : 'changed';
  }
  return { leftMarks, rightMarks };
}

/** [ から次の ] までを取り除く（閉じていない [ はそのまま残す） */
export function stripBracketed(s) {
  return s.replace(/\[[^\]]*\]/g, '');
}

/**
 * 同じ内容の行が 2 回以上出てくる行に、初出の行も含めて true を立てる。
 * [ ] で囲んだ部分（[サビ] などの見出し）と前後の空白は無視し、それで空になる行は数えない。
 */
export function findRepeatedLines(lines) {
  const flags = new Array(lines.length).fill(false);
  const first = new Map();
  lines.forEach((line, i) => {
    const s = stripBracketed(line).trim();
    if (s === '') return;
    if (first.has(s)) {
      flags[i] = true;
      flags[first.get(s)] = true;
    } else {
      first.set(s, i);
    }
  });
  return flags;
}
