// GitHub の Gist（非公開）を使って、作業中の内容を端末どうしで同期する。
//
// 各端末で、Gist の権限だけを持つ GitHub のアクセストークンを登録してもらう。
// Gist の中の lyricker-sync.json に { rev, updatedAt, device, state, prompts } を置き、
// rev（書き込むたびに 1 増える番号）で、他の端末が先に書き換えたかを見分ける。
//
//   - この端末だけが変わった … 書き込む
//   - 他の端末だけが変わった … 読み込む
//   - 両方が変わった（競合） … どちらを残すか利用者に選んでもらう
//
// APIキーは同期しない（Gist は暗号化されないため、キーは端末ごとに登録する）。

import * as store from './store.js';

const API = 'https://api.github.com';
const FILE = 'lyricker-sync.json';
/** 編集が止まってから書き込むまでの待ち時間 */
const PUSH_DELAY_MS = 2500;
/** 画面を開いている間、他の端末の更新を見に行く間隔 */
const POLL_MS = 60 * 1000;

export class SyncError extends Error {}

/** この端末の呼び名（競合したときに、どの端末の内容かを示すため） */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'ブラウザ';
}

async function github(token, path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (e) {
    throw new SyncError('通信できませんでした。インターネット接続を確認してください。');
  }
  if (res.ok) return res.json();
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* 本文なし */ }
  if (res.status === 401) throw new SyncError('トークンが正しくないか、期限が切れています。同期の設定で登録し直してください。');
  if (res.status === 403 || res.status === 404) {
    throw new SyncError(`トークンに Gist の権限が無いか、同期用の Gist が見つかりません（${res.status}）。\n${msg}`);
  }
  throw new SyncError(`GitHub のエラー (${res.status})\n${msg}`);
}

/** 同期用の Gist を探す。無ければ null */
async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await github(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

async function readGist(token, id) {
  const g = await github(token, `/gists/${id}`);
  const f = g.files?.[FILE];
  if (!f) throw new SyncError('同期用の Gist の中身が見つかりません。');
  let text = f.content;
  // 大きいときは中身が省略されるので、元のファイルを取りに行く
  if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try {
    const data = JSON.parse(text || '{}');
    return { ...data, rev: Number(data.rev) || 0 };
  } catch {
    return { rev: 0 };
  }
}

function fileContent(data) {
  return { files: { [FILE]: { content: JSON.stringify(data, null, 1) } } };
}

/**
 * 同期の係。hooks で画面とつなぐ。
 *   snapshot()              … 同期する内容 { state, prompts }
 *   apply(data)             … 他の端末の内容を画面に入れる
 *   status(kind, text)      … 状態の表示（kind: off / busy / ok / error / conflict）
 *   resolve(remote, local)  … 競合したとき 'remote' / 'local' / null（あとで）を返す
 */
export class GistSync {
  constructor(hooks) {
    this.hooks = hooks;
    this.meta = Object.assign({ token: '', gistId: '', base: 0, synced: '', device: deviceName() },
      store.load('cloud', {}));
    this.busy = false;
    this.again = false;
    this.timer = 0;
    this.lastPull = 0;
    setInterval(() => {
      if (document.visibilityState === 'visible') this.syncNow();
    }, POLL_MS);
  }

  get enabled() {
    return !!this.meta.token;
  }

  saveMeta() {
    store.save('cloud', this.meta);
  }

  /** トークンを登録して同期を始める（同期用の Gist を探し、無ければ作る） */
  async setup(token) {
    const meta = { token, gistId: '', base: 0, synced: '', device: this.meta.device };
    meta.gistId = await findGist(token);
    if (!meta.gistId) {
      // 作ったばかりの Gist は一覧に出るまで少しかかることがあるので、もう一度だけ探す
      // （見落として 2 つ目を作ると、端末ごとに別の Gist に同期してしまう）
      await new Promise((r) => setTimeout(r, 3000));
      meta.gistId = await findGist(token);
    }
    if (!meta.gistId) {
      const data = this.payload(1);
      const g = await github(token, '/gists', {
        method: 'POST',
        body: JSON.stringify({ description: 'Lyricker の同期データ（自動作成）', public: false, ...fileContent(data) }),
      });
      meta.gistId = g.id;
      meta.base = 1;
      meta.synced = JSON.stringify(this.hooks.snapshot());
    }
    this.meta = meta;
    this.saveMeta();
    await this.syncNow();
  }

  stop() {
    this.meta = { token: '', gistId: '', base: 0, synced: '', device: this.meta.device };
    this.saveMeta();
    this.hooks.status('off', '同期: オフ');
  }

  payload(rev) {
    return { app: 'lyricker', rev, updatedAt: new Date().toISOString(), device: this.meta.device, ...this.hooks.snapshot() };
  }

  /** 編集したあと、少し待ってから同期する */
  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), PUSH_DELAY_MS);
  }

  /** 画面に戻ったときなど。続けて呼ばれても 10 秒に 1 回まで */
  pullSoon() {
    if (Date.now() - this.lastPull > 10 * 1000) this.syncNow();
  }

  async syncNow() {
    if (!this.enabled) {
      this.hooks.status('off', '同期: オフ');
      return;
    }
    if (this.busy) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.busy = true;
    this.lastPull = Date.now();
    this.hooks.status('busy', '同期中…');
    try {
      const { token, gistId } = this.meta;
      const remote = await readGist(token, gistId);
      const local = JSON.stringify(this.hooks.snapshot());
      const dirty = local !== this.meta.synced;
      const remoteSnap = JSON.stringify({ state: remote.state, prompts: remote.prompts });

      if (remote.rev > this.meta.base && remoteSnap !== local) {
        // 他の端末が書き換えている
        let choice = 'remote';
        if (dirty && !this.isEmpty()) choice = await this.hooks.resolve(remote, JSON.parse(local));
        if (choice === 'remote') {
          this.hooks.apply(remote);
          this.meta.base = remote.rev;
          this.meta.synced = JSON.stringify(this.hooks.snapshot());
        } else if (choice === 'local') {
          await this.write(remote.rev + 1, local);
        } else {
          this.saveMeta();
          this.hooks.status('conflict', '同期: 未解決の競合');
          return;
        }
      } else if (remote.rev > this.meta.base) {
        // 内容は同じ（同じ編集が両方にある）
        this.meta.base = remote.rev;
        this.meta.synced = local;
      } else if (dirty) {
        await this.write(Math.max(remote.rev, this.meta.base) + 1, local);
      }
      this.saveMeta();
      const t = new Date();
      this.hooks.status('ok', `同期済み ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`);
    } catch (e) {
      this.hooks.status('error', '同期エラー', e.message);
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  async write(rev, localSnap) {
    const data = this.payload(rev);
    await github(this.meta.token, `/gists/${this.meta.gistId}`, {
      method: 'PATCH',
      body: JSON.stringify(fileContent(data)),
    });
    this.meta.base = rev;
    this.meta.synced = localSnap;
  }

  /** この端末に、まだ何も書いていないか（新しい端末なら他の端末の内容をそのまま読み込む） */
  isEmpty() {
    const s = this.hooks.snapshot().state;
    return (!s.left || s.left.length === 0) && !s.right;
  }
}
