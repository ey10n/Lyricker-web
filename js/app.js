// Lyricker（Web 版）
//
// 左のノートに元の歌詞を貼り付け、右のノートで編集する。左右を比べて、
// 右で変更した行（✓）・追加した行（+）、左には右で削除した行（−）を行頭に示す。
// 右のノートで同じ行が 2 回以上出てくる行は橙色にする。
// AI には右のノートの内容に指示を付けて送り、応答で右のノートを置き換えられる。
//
// 作業中の内容と設定はブラウザの中（localStorage）に自動で保存する。

import { computeLineAlignment, computeLineMarks, findRepeatedLines, isDiffRow } from './diff.js';
import * as store from './store.js';
import { AIError, findProvider, getProviders } from './ai.js';
import './gemini.js';
import { loadPrompts, savePrompts } from './prompts.js';
import { GistSync } from './cloud.js';

const $ = (id) => document.getElementById(id);

/** 文字数の上限（表示のみ。入力は制限しない） */
const MAX_CHARS = 5000;
/** これより狭い画面は 1 画面ずつのタブ表示にし、行を折り返す（app.css と同じ値） */
const NARROW_QUERY = '(max-width: 820px)';
/** 反転表示中の文字を含めて前後この文字数以内を再度ダブルクリックしたら消す */
const MARK_TOLERANCE = 2;

const SVG = {
  changed: '<svg viewBox="0 0 16 16"><polyline points="2,9 6,13 14,3" fill="none" stroke="#00a000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  added: '<svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11" stroke="#00a000" stroke-width="2.6" stroke-linecap="round"/></svg>',
  deleted: '<svg viewBox="0 0 16 16"><path d="M2.5 8h11" stroke="#e00000" stroke-width="2.6" stroke-linecap="round"/></svg>',
};

// 画面の部品
const paneLeft = $('paneLeft');
const leftScroll = $('leftScroll');
const leftRows = $('leftRows');
const leftPaste = $('leftPaste');
const rightScroll = $('rightScroll');
const rightRows = $('rightRows');
const rightText = $('rightText');
const statusMsg = $('statusMsg');

// 作業中の状態
const st = {
  left: [],          // 元の歌詞の行
  seeded: false,     // 左の内容を右に読み込んだか
  marks: [],         // 右のノートで反転表示している文字 { line, ch }（どちらも 0 始まり）
  prevLines: [],     // 直前の右のノートの行（反転表示の位置を追従させるため）
  rows: [],          // 左右の行の対応
  rightRowOf: [],    // 右の行 → 対応表の何番目か
  leftMarks: [],
  rightMarks: [],
  rightDiff: [],
  repeats: [],
  caretLine: 0,
  aiResult: '',
};

// 設定
const settings = Object.assign({
  fontSize: 15,
  sync: true,
  aiHeight: 240,
  tab: 'right',
  provider: 'gemini',
  prompt: '',
  providers: {},   // AI ごとの { account, accounts: { 名前: { key, model } }, model }
}, store.load('settings', {}));

let prompts = loadPrompts();
const narrowMedia = matchMedia(NARROW_QUERY);

function saveSettings() {
  store.save('settings', settings);
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let msgTimer = 0;
function showMsg(text) {
  statusMsg.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { statusMsg.textContent = ''; }, 4000);
}

function isNarrow() {
  return narrowMedia.matches;
}

// 右のノート ----------------------------------------------------------------

/** 右のノートの行。空のときは 0 行として扱う（差異の計算用） */
function rightLines() {
  return rightText.value === '' ? [] : rightText.value.split('\n');
}

/** 0 始まりの行 k の先頭の文字位置 */
function lineStart(text, k) {
  let pos = 0;
  for (let i = 0; i < k; i++) {
    const p = text.indexOf('\n', pos);
    if (p < 0) return text.length;
    pos = p + 1;
  }
  return pos;
}

function lineOfPos(text, pos) {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** 「指定行」の範囲（0 始まり）。選択があれば選択範囲の行、無ければカーソル行。
 *  選択が次の行の行頭で終わっているときは、その行は含めない */
function targetLines() {
  const v = rightText.value;
  const a = lineOfPos(v, rightText.selectionStart);
  let b = lineOfPos(v, rightText.selectionEnd);
  if (b > a && rightText.selectionEnd === lineStart(v, b)) b--;
  return [a, b];
}

/** 右のノートの文字の書き換えで、反転表示の位置を追従させる。
 *  書き換えた行の印は位置が当てにならないので消し、それより後ろの行はずらす */
function shiftMarks(oldLines, newLines) {
  if (!st.marks.length) return;
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (s < oldLines.length - p && s < newLines.length - p &&
         oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
  const oldEnd = oldLines.length - s;
  const delta = newLines.length - oldLines.length;
  st.marks = st.marks
    .filter((m) => m.line < p || m.line >= oldEnd)
    .map((m) => (m.line >= oldEnd ? { line: m.line + delta, ch: m.ch } : m))
    .filter((m) => m.line < newLines.length && m.ch < newLines[m.line].length);
}

function onRightInput() {
  const lines = rightText.value.split('\n');
  shiftMarks(st.prevLines, lines);
  st.prevLines = lines;
  update();
  persistSoon();
}

/** 右のノートを丸ごと置き換える。元に戻せる（Ctrl+Z）よう、入力と同じ操作で書き換える */
function replaceRight(text, caret) {
  if (!isNarrow()) rightText.focus({ preventScroll: true });
  rightText.setSelectionRange(0, rightText.value.length);
  let ok = false;
  try {
    ok = text === ''
      ? document.execCommand('delete')
      : document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok || rightText.value !== text) {
    rightText.value = text;
    onRightInput();
  }
  const pos = Math.min(caret ?? 0, text.length);
  rightText.setSelectionRange(pos, pos);
  updateCaret();
}

// 表示 ----------------------------------------------------------------------

function update() {
  const lines = rightLines();
  const rows = computeLineAlignment(st.left, lines);
  st.rows = rows;
  st.rightRowOf = new Array(lines.length).fill(-1);
  st.rightDiff = new Array(lines.length).fill(false);
  rows.forEach((r, i) => {
    if (r.right >= 0) {
      st.rightRowOf[r.right] = i;
      st.rightDiff[r.right] = isDiffRow(r);
    }
  });
  const marks = computeLineMarks(rows, lines.length);
  st.leftMarks = marks.leftMarks;
  st.rightMarks = marks.rightMarks;
  st.repeats = findRepeatedLines(lines);

  renderLeft();
  renderRight();
  updateCaret();
  updateCounts();
  updateStatus();
}

function renderLeft() {
  paneLeft.classList.toggle('empty', st.left.length === 0);
  $('btnPaste').disabled = st.left.length > 0;
  let html = '';
  st.rows.forEach((r, i) => {
    const filler = r.left < 0;   // 右にしか無い行の位置に入れる空行
    const cls = 'row' + (isDiffRow(r) ? ' diff' : '') + (filler ? ' filler' : '');
    html += `<div class="${cls}" data-r="${i}"><span class="num">${filler ? '' : r.left + 1}</span>` +
      `<span class="mk">${st.leftMarks[i] === 'deleted' ? SVG.deleted : ''}</span>` +
      `<span class="tx">${filler ? '' : esc(st.left[r.left])}</span></div>`;
  });
  leftRows.innerHTML = html;
}

/** 行の文字列に、反転表示する文字の印を入れた HTML */
function lineHtml(text, chs) {
  if (!chs || !chs.length) return esc(text);
  let html = '';
  let pos = 0;
  for (const ch of [...chs].sort((a, b) => a - b)) {
    if (ch < pos || ch >= text.length) continue;
    const len = text.codePointAt(ch) > 0xffff ? 2 : 1;
    html += esc(text.slice(pos, ch)) + `<span class="cm">${esc(text.slice(ch, ch + len))}</span>`;
    pos = ch + len;
  }
  return html + esc(text.slice(pos));
}

function renderRight() {
  const lines = rightText.value.split('\n');
  const marksByLine = new Map();
  for (const m of st.marks) {
    if (!marksByLine.has(m.line)) marksByLine.set(m.line, []);
    marksByLine.get(m.line).push(m.ch);
  }
  let html = '';
  lines.forEach((text, k) => {
    const cls = 'row' + (st.rightDiff[k] ? ' diff' : '') + (st.repeats[k] ? ' rep' : '');
    const mark = SVG[st.rightMarks[k]] || '';
    html += `<div class="${cls}"><span class="num">${k + 1}</span><span class="mk">${mark}</span>` +
      `<span class="tx">${lineHtml(text, marksByLine.get(k))}</span></div>`;
  });
  rightRows.innerHTML = html;
}

/** カーソル行の反転表示。左は右のカーソル行に対応する行を示す */
function updateCaret() {
  st.caretLine = lineOfPos(rightText.value, rightText.selectionStart);
  rightRows.querySelector('.row.caret')?.classList.remove('caret');
  leftRows.querySelector('.row.caret')?.classList.remove('caret');
  rightRows.children[st.caretLine]?.classList.add('caret');
  const r = st.rightRowOf[st.caretLine];
  if (r >= 0) leftRows.children[r]?.classList.add('caret');
}

/** 文字数。改行は 1 文字として数える */
function countChars(lines) {
  let n = Math.max(0, lines.length - 1);
  for (const line of lines) n += [...line].length;
  return n;
}

function setCount(el, n) {
  el.textContent = `${n}/${MAX_CHARS}`;
  el.classList.toggle('over', n > MAX_CHARS);
}

function updateCounts() {
  setCount($('leftCount'), countChars(st.left));
  setCount($('rightCount'), countChars(rightLines()));
}

function updateStatus() {
  const leftN = st.rows.filter(isDiffRow).length;
  const rightN = st.rightDiff.filter(Boolean).length;
  $('statusDiff').textContent = `差異: 左 ${leftN} 行 / 右 ${rightN} 行`;
}

// 保存（ブラウザ内） -----------------------------------------------------------

let persistTimer = 0;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 300);
}

function currentState() {
  return { left: st.left, right: rightText.value, marks: st.marks, seeded: st.seeded };
}

/** ブラウザ内に保存し、同期していれば少し後に他の端末へも送る */
function persist() {
  clearTimeout(persistTimer);
  store.save('state', currentState());
  cloud?.schedule();
}

function restore() {
  const s = store.load('state', null);
  if (!s) return;
  st.left = Array.isArray(s.left) ? s.left.map(String) : [];
  rightText.value = typeof s.right === 'string' ? s.right : '';
  st.marks = Array.isArray(s.marks) ? s.marks.filter((m) => Number.isInteger(m.line) && Number.isInteger(m.ch)) : [];
  st.seeded = !!s.seeded;
}

// 左のノート（貼り付けで読み込む） --------------------------------------------

/** 貼り付けた文字から取り除くもの（AI の出力などに付いてくる太字の印 **） */
function cleanPasted(text) {
  return text.replaceAll('**', '');
}

function loadLeft(text) {
  text = cleanPasted(text).replace(/\r\n?/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text === '') return;
  st.left = text.split('\n');
  // 新規のときは右にも同じ内容を読み込む
  if (!st.seeded || rightText.value === '') {
    rightText.value = text;
    st.marks = [];
    st.prevLines = rightText.value.split('\n');
    rightText.setSelectionRange(0, 0);
  }
  st.seeded = true;
  leftPaste.value = '';
  update();
  persist();
  if (isNarrow()) setTab('right');
  showMsg('元の歌詞を読み込みました');
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showMsg('クリップボードが空です');
      return;
    }
    loadLeft(text);
  } catch {
    alert('このブラウザではボタンからの貼り付けが許可されていません。\n' +
      '左のノートの枠を長押し（PC は右クリック）して「貼り付け」を選ぶか、Ctrl+V で貼り付けてください。');
    leftPaste.focus();
  }
}

/** 「クリア」: 確認してから左右のノートを両方クリアする */
function clearNotes() {
  if (st.left.length === 0 && rightText.value === '') return;
  if (!confirm('左右のノートの内容を全てクリアします。よろしいですか？')) return;
  st.left = [];
  st.marks = [];
  st.seeded = false;
  rightText.value = '';
  st.prevLines = [''];
  update();
  persist();
  if (isNarrow()) setTab('left');
}

// 戻す・コピー ------------------------------------------------------------------

/** 右のノートの指定行を元の歌詞に戻す。変更した行は元の内容に、追加した行は削除し、
 *  指定行の直前で削除した行（左の − の行）は元に戻す */
function revertLines() {
  if (!st.left.length) return;
  const lines = rightLines();
  const [a, b] = targetLines();
  const rowA = a > 0 && st.rightRowOf[a - 1] >= 0 ? st.rightRowOf[a - 1] + 1 : 0;
  const rowB = b >= lines.length - 1 ? st.rows.length - 1 : st.rightRowOf[b];
  const out = [];
  st.rows.forEach((r, i) => {
    if (i >= rowA && i <= rowB) {
      if (r.left >= 0) out.push(st.left[r.left]);
    } else if (r.right >= 0) {
      out.push(lines[r.right]);
    }
  });
  const text = out.join('\n');
  if (text === rightText.value) {
    showMsg('戻す変更はありません');
    return;
  }
  // カーソルは戻した範囲の先頭の行へ
  let k = 0;
  for (let i = 0; i < rowA; i++) if (st.rows[i].right >= 0) k++;
  replaceRight(text, lineStart(text, k));
  showMsg('元の歌詞に戻しました（Ctrl+Z で取り消せます）');
}

function revertAll() {
  if (!st.left.length) return;
  const text = st.left.join('\n');
  if (text === rightText.value) {
    showMsg('右のノートは元の歌詞と同じです');
    return;
  }
  if (rightText.value !== '' &&
      !confirm('右のノート全体を元の歌詞に戻します。よろしいですか？\n（Ctrl+Z で取り消せます）')) return;
  replaceRight(text, 0);
}

async function copyRight() {
  const text = rightText.value;
  if (text === '') {
    showMsg('右のノートが空です');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 古いブラウザ向け
    const sel = [rightText.selectionStart, rightText.selectionEnd];
    rightText.focus({ preventScroll: true });
    rightText.select();
    document.execCommand('copy');
    rightText.setSelectionRange(sel[0], sel[1]);
  }
  showMsg('右のノートの全文をコピーしました');
}

// 差異の移動 ------------------------------------------------------------------

function scrollRowIntoView(scroller, row) {
  if (!row) return;
  const top = row.offsetTop;
  if (top < scroller.scrollTop || top + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
  }
}

function gotoDiff(back) {
  // 狭い画面で左を見ているときは、左のノートの中で移動する
  if (isNarrow() && settings.tab === 'left') {
    const from = Math.floor(leftScroll.scrollTop / lineHeight());
    const idx = findDiff(st.rows.map(isDiffRow), from, back);
    if (idx < 0) return showMsg('これ以上、差異はありません');
    leftScroll.scrollTop = leftRows.children[idx].offsetTop;
    return;
  }
  // カーソル行はその場で数え直す（selectionchange は少し遅れて届くことがある）
  const idx = findDiff(st.rightDiff, lineOfPos(rightText.value, rightText.selectionStart), back);
  if (idx < 0) return showMsg('これ以上、差異はありません');
  const pos = lineStart(rightText.value, idx);
  if (!isNarrow()) rightText.focus({ preventScroll: true });
  rightText.setSelectionRange(pos, pos);
  updateCaret();
  scrollRowIntoView(rightScroll, rightRows.children[idx]);
}

function findDiff(flags, from, back) {
  if (back) {
    for (let i = Math.min(from, flags.length) - 1; i >= 0; i--) if (flags[i]) return i;
  } else {
    for (let i = from + 1; i < flags.length; i++) if (flags[i]) return i;
  }
  return -1;
}

// スクロールの同期（広い画面） --------------------------------------------------

function lineHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh')) || 24;
}

let ignoreLeftScroll = false;
let ignoreRightScroll = false;

function syncFromRight() {
  if (ignoreRightScroll) { ignoreRightScroll = false; return; }
  if (isNarrow() || !settings.sync) return;
  const lh = lineHeight();
  const pos = rightScroll.scrollTop / lh;
  const k = Math.floor(pos);
  let r;
  if (k < st.rightRowOf.length && st.rightRowOf[k] >= 0) r = st.rightRowOf[k] + (pos - k);
  else r = st.rows.length + (pos - st.rightRowOf.length);
  setScroll(leftScroll, Math.max(0, r) * lh, rightScroll.scrollLeft, true);
}

function syncFromLeft() {
  if (ignoreLeftScroll) { ignoreLeftScroll = false; return; }
  if (isNarrow() || !settings.sync) return;
  const lh = lineHeight();
  const pos = leftScroll.scrollTop / lh;
  const r = Math.floor(pos);
  let k = -1;
  let frac = 0;
  for (let i = r; i < st.rows.length; i++) {
    if (st.rows[i].right >= 0) {
      k = st.rows[i].right;
      if (i === r) frac = pos - r;
      break;
    }
  }
  if (k < 0) k = st.rightRowOf.length + (r - st.rows.length);
  setScroll(rightScroll, Math.max(0, k + frac) * lh, leftScroll.scrollLeft, false);
}

function setScroll(el, top, left, isLeft) {
  if (Math.abs(el.scrollTop - top) < 1 && Math.abs(el.scrollLeft - left) < 1) return;
  if (isLeft) ignoreLeftScroll = true;
  else ignoreRightScroll = true;
  el.scrollTop = top;
  el.scrollLeft = left;
}

// 右のノートのダブルクリックで 1 文字を反転表示する ------------------------------

function charAtPoint(x, y) {
  // 入力欄は文字が透明なので、下に重ねた行から文字の位置を調べる
  rightText.style.pointerEvents = 'none';
  let node = null;
  let offset = 0;
  try {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    }
  } finally {
    rightText.style.pointerEvents = '';
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const tx = node.parentElement?.closest('.tx');
  const row = tx?.parentElement;
  if (!tx || !row || row.parentElement !== rightRows) return null;

  // クリックした位置を含む文字を、前後の候補から選ぶ
  const range = document.createRange();
  let local = -1;
  for (const cand of [offset, offset - 1]) {
    if (cand < 0 || cand >= node.length) continue;
    range.setStart(node, cand);
    range.setEnd(node, cand + 1);
    const rect = range.getBoundingClientRect();
    if (x >= rect.left - 1 && x <= rect.right + 1) { local = cand; break; }
  }
  if (local < 0) return null;

  // 行の中での位置（反転表示の span で分かれている分を足す）
  let ch = local;
  const walker = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t && t !== node; t = walker.nextNode()) ch += t.length;
  const text = rightText.value.split('\n')[[...rightRows.children].indexOf(row)] ?? '';
  // サロゲートペアの後半なら前半に寄せる
  if (ch > 0 && /[\udc00-\udfff]/.test(text[ch]) && /[\ud800-\udbff]/.test(text[ch - 1])) ch--;
  return { line: [...rightRows.children].indexOf(row), ch };
}

function onRightDoubleClick(e) {
  const hit = charAtPoint(e.clientX, e.clientY);
  // ダブルクリックでの単語選択はしない（カーソルだけ置く）
  const end = rightText.selectionEnd;
  rightText.setSelectionRange(end, end);
  if (!hit) return;
  const idx = st.marks.findIndex((m) => m.line === hit.line && Math.abs(m.ch - hit.ch) <= MARK_TOLERANCE);
  if (idx >= 0) st.marks.splice(idx, 1);
  else st.marks.push(hit);
  renderRight();
  updateCaret();
  persistSoon();
}

// 画面の切り替え・文字の大きさ ---------------------------------------------------

function setTab(tab) {
  settings.tab = tab;
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  saveSettings();
}

function applyLayout() {
  const narrow = isNarrow();
  document.body.classList.toggle('wrap', narrow);
  rightText.setAttribute('wrap', narrow ? 'soft' : 'off');
  // iPhone は 16px 未満の入力欄に触れると画面を拡大してしまうので、狭い画面では 16px 以上
  const fs = narrow ? Math.max(16, settings.fontSize) : settings.fontSize;
  document.documentElement.style.setProperty('--fs', fs + 'px');
  document.documentElement.style.setProperty('--lh', Math.round(fs * 1.6) + 'px');
  document.documentElement.style.setProperty('--ai-h', settings.aiHeight + 'px');
}

function changeFont(delta) {
  settings.fontSize = Math.min(28, Math.max(11, settings.fontSize + delta));
  saveSettings();
  applyLayout();
  syncFromRight();
}

function initSplitter() {
  const split = $('aiSplit');
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const main = $('main').getBoundingClientRect();
    const move = (ev) => {
      settings.aiHeight = Math.round(Math.min(main.height - 200, Math.max(120, main.bottom - ev.clientY - 6)));
      applyLayout();
    };
    const up = () => {
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      saveSettings();
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
}

// AI ------------------------------------------------------------------------

const selProvider = $('selProvider');
const selAccount = $('selAccount');
const inpModel = $('inpModel');
const selPrompt = $('selPrompt');
const aiPrompt = $('aiPrompt');
const aiResult = $('aiResult');
let aiAbort = null;

function currentProvider() {
  return findProvider(selProvider.value) || getProviders()[0];
}

/** AI ごとの設定（キーの一覧とモデル）。accounts の t と deleted は、他の端末と合わせるための時刻 */
function providerConfig(p) {
  const all = settings.providers;
  if (!all[p.id]) all[p.id] = { account: '', accounts: {}, model: '' };
  if (!all[p.id].deleted) all[p.id].deleted = {};
  return all[p.id];
}

/** 他の端末と同期する APIキーの一覧（どのキーを選んでいるかは端末ごとなので含めない） */
function getSecrets() {
  const providers = {};
  for (const [pid, cfg] of Object.entries(settings.providers)) {
    const accounts = {};
    for (const [name, a] of Object.entries(cfg.accounts || {})) {
      accounts[name] = { key: a.key, model: a.model || '', t: a.t || 0 };
    }
    providers[pid] = { accounts, deleted: { ...(cfg.deleted || {}) } };
  }
  return { providers };
}

/** 他の端末と合わせた APIキーの一覧を入れる */
function applySecrets(merged) {
  for (const [pid, m] of Object.entries(merged.providers || {})) {
    const cfg = settings.providers[pid] || (settings.providers[pid] = { account: '', accounts: {}, model: '' });
    cfg.accounts = m.accounts || {};
    cfg.deleted = m.deleted || {};
  }
  saveSettings();
  refreshAccounts(providerConfig(currentProvider()).account);
  showMsg('他の端末の APIキーを読み込みました');
}

function currentAccount() {
  const cfg = providerConfig(currentProvider());
  const name = selAccount.value;
  return cfg.accounts[name] ? { name, ...cfg.accounts[name] } : null;
}

function refreshProviders() {
  selProvider.innerHTML = getProviders()
    .map((p) => `<option value="${esc(p.id)}">${esc(p.displayName)}</option>`).join('');
  selProvider.value = findProvider(settings.provider) ? settings.provider : getProviders()[0].id;
}

/** キーの一覧を作り直して selectName を選ぶ（空なら前回選んでいたキー）。
 *  モデル欄も、選んだキーで使っていたモデルに入れ替える */
function refreshAccounts(selectName) {
  const p = currentProvider();
  const cfg = providerConfig(p);
  const names = Object.keys(cfg.accounts);
  selAccount.innerHTML = names.length
    ? names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : '<option value="">（未登録）</option>';
  const want = selectName || cfg.account;
  selAccount.value = names.includes(want) ? want : (names[0] || '');
  cfg.account = selAccount.value;
  const acct = currentAccount();
  inpModel.value = acct?.model || cfg.model || p.defaultModel;
  $('modelList').innerHTML = '';
  $('btnKeyEdit').disabled = !acct;
  $('btnKeyDelete').disabled = !acct;
  saveSettings();
}

/** モデル欄の内容を、選んでいるキー（キーが無ければ AI 全体）の設定として覚える */
function saveModel() {
  const cfg = providerConfig(currentProvider());
  const model = inpModel.value.trim();
  const name = selAccount.value;
  const acct = cfg.accounts[name];
  if (acct) {
    if (acct.model !== model) {
      acct.model = model;
      acct.t = Date.now();
      cloud?.schedule();
    }
  } else {
    cfg.model = model;
  }
  saveSettings();
}

/** APIキーの入力画面。{ name, key } か、取り消したら null */
function openKeyDialog({ title, name = '', key = '', nameEditable = true }) {
  const dlg = $('dlgKey');
  $('dlgKeyTitle').textContent = title;
  $('dlgKeyName').value = name;
  $('dlgKeyName').readOnly = !nameEditable;
  $('dlgKeyValue').value = key;
  $('dlgKeyHelp').innerHTML = currentProvider().keyHelp || '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve({ name: $('dlgKeyName').value.trim(), key: $('dlgKeyValue').value.trim() });
    }, { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    (nameEditable ? $('dlgKeyName') : $('dlgKeyValue')).focus();
  });
}

async function addKey() {
  const p = currentProvider();
  const cfg = providerConfig(p);
  const res = await openKeyDialog({ title: `${p.displayName} の APIキーを追加` });
  if (!res || !res.name || !res.key) {
    if (res) alert('キー名と APIキーの両方を入力してください。');
    return false;
  }
  if (cfg.accounts[res.name] &&
      !confirm(`「${res.name}」は既にあります。キーを置き換えますか？`)) return false;
  saveModel();
  cfg.accounts[res.name] = {
    key: res.key,
    model: cfg.accounts[res.name]?.model || inpModel.value.trim() || p.defaultModel,
    t: Date.now(),
  };
  delete cfg.deleted[res.name];
  refreshAccounts(res.name);
  cloud?.schedule();
  showMsg(`APIキー「${res.name}」を登録しました`);
  return true;
}

async function editKey() {
  const acct = currentAccount();
  if (!acct) return;
  const res = await openKeyDialog({ title: `APIキー「${acct.name}」を変更`, name: acct.name, key: acct.key, nameEditable: false });
  if (!res) return;
  if (!res.key) {
    alert('キーを消すときは「削除」を使ってください。');
    return;
  }
  const a = providerConfig(currentProvider()).accounts[acct.name];
  a.key = res.key;
  a.t = Date.now();
  saveSettings();
  cloud?.schedule();
  showMsg('APIキーを変更しました');
}

function deleteKey() {
  const acct = currentAccount();
  if (!acct) return;
  if (!confirm(`APIキー「${acct.name}」を削除しますか？\n（同期している他の端末からも削除されます）`)) return;
  const cfg = providerConfig(currentProvider());
  delete cfg.accounts[acct.name];
  // 削除したことを他の端末にも伝えるため、時刻を残す
  cfg.deleted[acct.name] = Date.now();
  refreshAccounts('');
  cloud?.schedule();
}

async function fetchModels() {
  const p = currentProvider();
  const acct = currentAccount();
  if (!acct) {
    alert('モデル一覧の取得には APIキーが必要です。「追加」から登録してください。');
    return;
  }
  const btn = $('btnModels');
  btn.disabled = true;
  try {
    const names = await p.listModels({ apiKey: acct.key });
    $('modelList').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
    showMsg(`モデルを ${names.length} 件取得しました。モデル欄から選べます`);
    inpModel.focus();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

function refreshPrompts(selectName) {
  selPrompt.innerHTML = '<option value="">（選択してください）</option>' +
    prompts.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  selPrompt.value = prompts.some((p) => p.name === selectName) ? selectName : '';
  settings.prompt = selPrompt.value;
  $('btnPromptDelete').disabled = !selPrompt.value;
  saveSettings();
}

function selectPrompt() {
  const p = prompts.find((x) => x.name === selPrompt.value);
  if (p) aiPrompt.value = p.text;
  settings.prompt = selPrompt.value;
  $('btnPromptDelete').disabled = !selPrompt.value;
  saveSettings();
}

function savePrompt() {
  const text = aiPrompt.value.trim();
  if (!text) {
    alert('保存する指示を、指示の欄に入力してください。');
    return;
  }
  const name = (prompt('指示の名前（同じ名前があれば上書きします）', selPrompt.value) || '').trim();
  if (!name) return;
  const idx = prompts.findIndex((p) => p.name === name);
  if (idx >= 0 && name !== selPrompt.value && !confirm(`「${name}」は既にあります。上書きしますか？`)) return;
  if (idx >= 0) prompts[idx].text = text;
  else prompts.push({ name, text });
  if (!savePrompts(prompts)) alert('指示の一覧を保存できませんでした。');
  refreshPrompts(name);
  cloud?.schedule();
  showMsg(`指示「${name}」を保存しました`);
}

function deletePrompt() {
  const name = selPrompt.value;
  if (!name || !confirm(`指示「${name}」を一覧から削除しますか？`)) return;
  prompts = prompts.filter((p) => p.name !== name);
  savePrompts(prompts);
  refreshPrompts('');
  cloud?.schedule();
}

function setAIBusy(busy) {
  const run = $('btnRun');
  run.textContent = busy ? '中止 ■' : '実行 ▶';
  run.classList.toggle('busy', busy);
  selProvider.disabled = busy;
  selAccount.disabled = busy;
  inpModel.disabled = busy;
  $('btnApply').disabled = busy || !st.aiResult;
}

/** AI の応答の前後の空行と、全体を囲む ``` と、太字の印 ** を取り除く */
function cleanResult(text) {
  const lines = cleanPasted(text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length >= 2 && lines[0].trim().startsWith('```') && lines[lines.length - 1].trim() === '```') {
    lines.pop();
    lines.shift();
  }
  return lines.join('\n');
}

async function runAI() {
  if (aiAbort) {
    aiAbort.abort();
    return;
  }
  const p = currentProvider();
  let acct = currentAccount();
  if (!acct) {
    if (!(await addKey())) return;
    acct = currentAccount();
    if (!acct) return;
  }
  // 自由文の欄に書いてあれば、指示の代わりにそれを送る
  const inpFree = $('inpFree');
  const free = inpFree.value.trim();
  const instruction = free || aiPrompt.value.trim();
  if (!instruction) {
    alert('指示を一覧から選ぶか、指示の欄に入力してください。');
    return;
  }
  const hasLyrics = rightText.value.trim() !== '';
  if (!free && !hasLyrics) {
    alert('右のノートが空です。');
    return;
  }
  const model = inpModel.value.trim() || p.defaultModel;
  inpModel.value = model;
  saveModel();

  // 右のノートが空なら、自由文だけを送る
  const promptText = hasLyrics
    ? `${instruction}\n\n--- 対象テキスト ---\n${rightText.value}`
    : instruction;
  inpFree.value = '';
  aiAbort = new AbortController();
  st.aiResult = '';
  aiResult.value = 'AI に問い合わせています…';
  setAIBusy(true);
  try {
    st.aiResult = cleanResult(await p.generate({ apiKey: acct.key, model, prompt: promptText, signal: aiAbort.signal }));
    aiResult.value = st.aiResult;
  } catch (e) {
    aiResult.value = '';
    if (e.name === 'AbortError') showMsg('AI への問い合わせを中止しました');
    else alert(e instanceof AIError ? e.message : 'エラー: ' + e.message);
  } finally {
    aiAbort = null;
    setAIBusy(false);
  }
}

function applyAIResult() {
  if (!st.aiResult || aiAbort) return;
  if (isNarrow()) setTab('right');
  replaceRight(st.aiResult, 0);
  rightScroll.scrollTop = 0;
  showMsg('AI の応答を右のノートに反映しました（Ctrl+Z で取り消せます）');
}

// 他の端末との同期（GitHub の Gist） ---------------------------------------------

let cloud = null;

/** 他の端末から届いた内容を画面に入れる（この端末の内容は置き換わる） */
function applyRemote(data) {
  const s = data.state || {};
  st.left = Array.isArray(s.left) ? s.left.map(String) : [];
  rightText.value = typeof s.right === 'string' ? s.right : '';
  st.marks = Array.isArray(s.marks) ? s.marks.filter((m) => Number.isInteger(m.line) && Number.isInteger(m.ch)) : [];
  st.seeded = !!s.seeded;
  st.prevLines = rightText.value.split('\n');
  rightText.setSelectionRange(0, 0);
  if (Array.isArray(data.prompts)) {
    prompts = data.prompts.filter((p) => p && typeof p.name === 'string' && typeof p.text === 'string');
    savePrompts(prompts);
    refreshPrompts(settings.prompt);
    selectPrompt();
  }
  update();
  store.save('state', currentState());
  showMsg(`他の端末（${data.device || '不明'}）の内容を読み込みました`);
}

function setSyncStatus(kind, text, detail = '') {
  const btn = $('btnSync');
  btn.dataset.kind = kind;
  $('syncText').textContent = text;
  btn.title = detail ? `${text}\n${detail}` : `他の端末との同期（${text}）`;
  if (kind === 'error') showMsg(text + ': ' + detail.split('\n')[0]);
}

function preview(state) {
  const text = state?.right || '';
  return text === '' ? '（空）' : text;
}

/** 競合したとき、どちらを残すかを選んでもらう */
function resolveConflict(remote, local) {
  const dlg = $('dlgConflict');
  $('cfRemote').textContent = preview(remote.state);
  $('cfLocal').textContent = preview(local.state);
  const when = remote.updatedAt ? new Date(remote.updatedAt).toLocaleString('ja-JP') : '';
  $('cfRemoteInfo').textContent = `（${remote.device || '不明'}・${when}）`;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue;
      resolve(v === 'remote' || v === 'local' ? v : null);
    }, { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function openSyncDialog() {
  const dlg = $('dlgSync');
  $('dlgSyncToken').value = cloud.meta.token;
  $('dlgSyncStop').disabled = !cloud.enabled;
  // 同期先の Gist の番号の頭を見せて、端末どうしで同じ所に同期しているか確かめられるようにする
  $('dlgSyncState').textContent = cloud.enabled
    ? `同期中: ${$('syncText').textContent}（同期先 Gist ${cloud.meta.gistId.slice(0, 7)}）`
    : 'まだ同期していません。';
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'stop') {
      if (confirm('この端末の同期を止めます。よろしいですか？\n（この端末の内容と、GitHub の Gist はそのまま残ります）')) cloud.stop();
      return;
    }
    if (dlg.returnValue !== 'ok') return;
    const token = $('dlgSyncToken').value.trim();
    if (!token) {
      alert('トークンを貼り付けてください。');
      return;
    }
    persist();
    setSyncStatus('busy', '同期の準備中…');
    try {
      await cloud.setup(token);
    } catch (e) {
      setSyncStatus('error', '同期エラー', e.message);
      alert(e.message);
    }
  }, { once: true });
  dlg.returnValue = '';
  dlg.showModal();
}

function initCloud() {
  cloud = new GistSync({
    snapshot: () => ({ state: currentState(), prompts }),
    apply: applyRemote,
    getSecrets,
    applySecrets,
    status: setSyncStatus,
    resolve: resolveConflict,
  });
  $('btnSync').addEventListener('click', openSyncDialog);
  document.addEventListener('visibilitychange', () => {
    // 戻ってきたら他の端末の更新を見に行き、離れるときはこの端末の変更を送る
    if (document.visibilityState === 'visible') cloud.pullSoon();
    else cloud.syncNow();
  });
  if (cloud.enabled) cloud.syncNow();
  else setSyncStatus('off', '同期: オフ');
}

// 起動 ------------------------------------------------------------------------

function bind() {
  // 右のノート
  rightText.addEventListener('input', onRightInput);
  // 貼り付けるときに ** を取り除く（元に戻せるよう、入力と同じ操作で入れる）
  rightText.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text || !text.includes('**')) return;
    e.preventDefault();
    const cleaned = cleanPasted(text);
    let ok = false;
    try { ok = document.execCommand('insertText', false, cleaned); } catch { ok = false; }
    if (!ok) {
      rightText.setRangeText(cleaned, rightText.selectionStart, rightText.selectionEnd, 'end');
      onRightInput();
    }
  });
  rightText.addEventListener('dblclick', onRightDoubleClick);
  for (const ev of ['keyup', 'click', 'focus', 'select']) rightText.addEventListener(ev, updateCaret);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === rightText) updateCaret();
  });
  rightScroll.addEventListener('scroll', syncFromRight, { passive: true });
  leftScroll.addEventListener('scroll', syncFromLeft, { passive: true });

  // 左のノート: 行をクリックすると右の対応する行へ
  leftRows.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row || isNarrow()) return;
    const r = Number(row.dataset.r);
    let k = -1;
    for (let i = r; i < st.rows.length && k < 0; i++) if (st.rows[i].right >= 0) k = st.rows[i].right;
    if (k < 0) k = Math.max(0, rightText.value.split('\n').length - 1);
    const pos = lineStart(rightText.value, k);
    rightText.focus({ preventScroll: true });
    rightText.setSelectionRange(pos, pos);
    updateCaret();
  });

  // 左が空のときの貼り付け欄。貼り付けだけを受け付ける（元の歌詞は直接編集しない）
  leftPaste.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertFromPaste') e.preventDefault();
  });
  leftPaste.addEventListener('paste', (e) => {
    e.preventDefault();
    loadLeft(e.clipboardData?.getData('text/plain') || '');
  });

  $('btnPaste').addEventListener('click', pasteFromClipboard);
  $('btnClear').addEventListener('click', clearNotes);
  $('btnRevertLines').addEventListener('click', revertLines);
  $('btnRevertAll').addEventListener('click', revertAll);
  $('btnCopy').addEventListener('click', copyRight);
  $('btnPrevDiff').addEventListener('click', () => gotoDiff(true));
  $('btnNextDiff').addEventListener('click', () => gotoDiff(false));
  $('chkSync').checked = settings.sync;
  $('chkSync').addEventListener('change', (e) => {
    settings.sync = e.target.checked;
    saveSettings();
    syncFromRight();
  });
  $('btnFontDown').addEventListener('click', () => changeFont(-1));
  $('btnFontUp').addEventListener('click', () => changeFont(1));
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  }
  narrowMedia.addEventListener('change', () => {
    applyLayout();
    syncFromRight();
  });
  initSplitter();

  // AI
  selProvider.addEventListener('change', () => {
    settings.provider = selProvider.value;
    refreshAccounts('');
  });
  selAccount.addEventListener('change', () => {
    providerConfig(currentProvider()).account = selAccount.value;
    refreshAccounts(selAccount.value);
  });
  inpModel.addEventListener('change', saveModel);
  $('btnKeyAdd').addEventListener('click', addKey);
  $('btnKeyEdit').addEventListener('click', editKey);
  $('btnKeyDelete').addEventListener('click', deleteKey);
  $('btnModels').addEventListener('click', fetchModels);
  selPrompt.addEventListener('change', selectPrompt);
  $('btnPromptSave').addEventListener('click', savePrompt);
  $('btnPromptDelete').addEventListener('click', deletePrompt);
  $('btnRun').addEventListener('click', runAI);
  // 自由文の欄で Enter を押したら送る（日本語入力の変換を確定する Enter は除く）
  $('inpFree').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      runAI();
    }
  });
  $('btnApply').addEventListener('click', applyAIResult);

  // キー操作
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runAI();
    } else if (e.key === 'F3') {
      e.preventDefault();
      gotoDiff(e.shiftKey);
    }
  });

  // 閉じる直前に、待っている保存を済ませる
  addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });
}

function start() {
  restore();
  st.prevLines = rightText.value.split('\n');
  applyLayout();
  setTab(settings.tab || 'right');
  bind();
  refreshProviders();
  refreshAccounts('');
  // 初回は一覧の先頭の指示を選んでおく
  refreshPrompts(settings.prompt || prompts[0]?.name || '');
  selectPrompt();
  setAIBusy(false);
  update();
  initCloud();
  // 新規（左が空）で狭い画面なら、まず貼り付けの画面を出す
  if (isNarrow() && st.left.length === 0 && rightText.value === '') setTab('left');

  // オフラインでも開けるようにする（https か localhost のときだけ使える）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
