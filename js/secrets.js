// AI の APIキーを、他の端末と同期するために暗号化する。
//
// 非公開の Gist でも、URL を知っていれば誰でも中身を読めてしまうので、
// APIキーは GitHub のトークンから作った鍵で暗号化してから置く。
// トークンを登録した端末だけが読める。Windows / Mac 版（ugistsync.pas）と同じ方式。
//
//   鍵   PBKDF2-HMAC-SHA256（トークン, salt, 100000 回）→ 64 バイト
//        前半 32 バイトを暗号用、後半 32 バイトを改ざん検出用に使う
//   暗号 HMAC-SHA256(暗号用の鍵, nonce + 4 バイトの番号) を並べた列と XOR
//   検出 HMAC-SHA256(改ざん検出用の鍵, salt + nonce + 暗号文)
//
// 同期するキーの一覧は { providers: { gemini: { accounts: { 名前: { key, model, t } },
//                                              deleted: { 名前: t } } } }。
// t は追加・変更・削除した時刻（ミリ秒）。端末どうしで合わせるときは、名前ごとに新しい方を残す。

const ITERATIONS = 100000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map();

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

async function deriveKeys(token, salt) {
  const id = token + ':' + b64(salt);
  if (keyCache.has(id)) return keyCache.get(id);
  const base = await crypto.subtle.importKey('raw', enc.encode(token), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 512));
  const hmacKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const keys = { enc: await hmacKey(bits.slice(0, 32)), mac: await hmacKey(bits.slice(32)) };
  keyCache.set(id, keys);
  return keys;
}

async function hmac(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function xorStream(key, nonce, data) {
  const out = new Uint8Array(data.length);
  for (let block = 0; block * 32 < data.length; block++) {
    const counter = new Uint8Array([block >>> 24, (block >>> 16) & 255, (block >>> 8) & 255, block & 255]);
    const ks = await hmac(key, concat(nonce, counter));
    for (let i = 0; i < 32 && block * 32 + i < data.length; i++) {
      out[block * 32 + i] = data[block * 32 + i] ^ ks[i];
    }
  }
  return out;
}

/** 同期用に暗号化する。saltText を渡すと同じ salt を使う（鍵の計算を省ける） */
export async function encryptSecrets(token, obj, saltText) {
  const salt = saltText ? unb64(saltText) : crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const keys = await deriveKeys(token, salt);
  const data = await xorStream(keys.enc, nonce, enc.encode(JSON.stringify(obj)));
  const tag = await hmac(keys.mac, concat(salt, nonce, data));
  return { v: 1, salt: b64(salt), nonce: b64(nonce), data: b64(data), tag: b64(tag) };
}

/** 復号する。トークンが違う・改ざんされているときは例外 */
export async function decryptSecrets(token, box) {
  if (!box || box.v !== 1) throw new Error('対応していない形式です');
  const salt = unb64(box.salt);
  const nonce = unb64(box.nonce);
  const data = unb64(box.data);
  const keys = await deriveKeys(token, salt);
  const tag = await hmac(keys.mac, concat(salt, nonce, data));
  const expected = unb64(box.tag);
  let diff = tag.length ^ expected.length;
  for (let i = 0; i < Math.min(tag.length, expected.length); i++) diff |= tag[i] ^ expected[i];
  if (diff !== 0) throw new Error('APIキーを復号できません（トークンが違います）');
  return JSON.parse(dec.decode(await xorStream(keys.enc, nonce, data)));
}

/** 2 つのキーの一覧を合わせる。名前ごとに、追加・変更・削除のうち新しいものを残す */
export function mergeSecrets(a, b) {
  const out = { providers: {} };
  const pa = a?.providers || {};
  const pb = b?.providers || {};
  for (const pid of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const A = pa[pid] || {};
    const B = pb[pid] || {};
    const accounts = {};
    const deleted = {};
    const names = new Set([
      ...Object.keys(A.accounts || {}), ...Object.keys(B.accounts || {}),
      ...Object.keys(A.deleted || {}), ...Object.keys(B.deleted || {}),
    ]);
    for (const name of names) {
      const cands = [];
      for (const S of [A, B]) {
        const acc = S.accounts?.[name];
        if (acc) cands.push({ del: false, t: Number(acc.t) || 0, acc });
        if (S.deleted?.[name] !== undefined) cands.push({ del: true, t: Number(S.deleted[name]) || 0 });
      }
      // 新しいものを残す。同じ時刻なら、削除よりキーを残す
      cands.sort((x, y) => (y.t - x.t) || (x.del - y.del));
      const w = cands[0];
      if (w.del) deleted[name] = w.t;
      else accounts[name] = { key: String(w.acc.key || ''), model: String(w.acc.model || ''), t: w.t };
    }
    out.providers[pid] = { accounts, deleted };
  }
  return out;
}

/** 比べるための文字列（項目の順番をそろえる） */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
