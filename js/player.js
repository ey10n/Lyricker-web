// 曲の再生。Suno などからダウンロードした曲のファイルを開いて、歌詞を見ながら聴く。
//
// 曲はこの端末の中で読むだけで、どこにも送らない。読み込み直しても続きから聴けるよう、
// 最後に開いた 1 曲と再生位置をブラウザの中（IndexedDB）に置いておく。
// 置けない（プライベートブラウズなど）ときは、置かずに再生だけする。

const DB_NAME = 'lyricker-player';
const STORE = 'song';
const KEY = 'last';
/** 戻す・進める秒数 */
export const SKIP_SEC = 5;

const $ = (id) => document.getElementById(id);

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const dbGet = () => dbRun('readonly', (s) => s.get(KEY));
const dbPut = (value) => dbRun('readwrite', (s) => s.put(value, KEY));
const dbDelete = () => dbRun('readwrite', (s) => s.delete(KEY));

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 拡張子を除いたファイル名を曲名にする */
function songTitle(fileName) {
  return (fileName || '曲').replace(/\.[^.]+$/, '');
}

export function initPlayer({ showMsg, onLayout }) {
  const audio = new Audio();
  audio.preload = 'auto';
  const bar = $('playerBar');
  const seek = $('plSeek');
  const btnPlay = $('plPlay');
  const fileInput = $('plFile');
  let url = '';
  let title = '';
  let seeking = false;
  let saveTimer = 0;

  function setVisible(on) {
    bar.hidden = !on;
    onLayout?.();
  }

  function render() {
    const dur = audio.duration;
    const cur = audio.currentTime;
    $('plTime').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    if (!seeking) {
      seek.max = Number.isFinite(dur) ? String(dur) : '0';
      seek.value = String(cur);
    }
    const playing = !audio.paused && !audio.ended;
    btnPlay.textContent = playing ? '❚❚' : '▶';
    btnPlay.title = playing ? '一時停止（F2）' : '再生（F2）';
    btnPlay.setAttribute('aria-label', playing ? '一時停止' : '再生');
  }

  // 再生位置は少し間をおいて置く（読み込み直したとき続きから聴けるように）
  function savePositionSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 1500);
  }
  async function savePosition() {
    clearTimeout(saveTimer);
    if (!url) return;
    try {
      const rec = await dbGet();
      if (rec) {
        rec.pos = audio.currentTime;
        await dbPut(rec);
      }
    } catch {
      // 置けなくても再生は続ける
    }
  }

  function load(blob, name, pos = 0) {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    title = songTitle(name);
    audio.src = url;
    $('plTitle').textContent = title;
    $('plTitle').title = name || '';
    if (pos > 0) {
      audio.addEventListener('loadedmetadata', () => {
        audio.currentTime = Math.min(pos, Math.max(0, audio.duration - 1));
      }, { once: true });
    }
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Lyricker' });
    }
    setVisible(true);
    render();
  }

  async function openFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
      showMsg('曲のファイル（mp3 など）を選んでください');
      return;
    }
    audio.pause();
    load(file, file.name);
    try {
      await dbPut({ blob: file, name: file.name, pos: 0 });
    } catch {
      // 置けなくても再生はできる（読み込み直すと消える）
    }
    showMsg(`曲を開きました: ${title}`);
  }

  async function closeSong() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (url) URL.revokeObjectURL(url);
    url = '';
    title = '';
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    try { await dbDelete(); } catch { /* 無くてもよい */ }
    setVisible(false);
  }

  function togglePlay() {
    if (!url) {
      fileInput.click();
      return;
    }
    if (audio.paused || audio.ended) audio.play().catch(() => showMsg('再生できませんでした'));
    else audio.pause();
  }

  function stop() {
    audio.pause();
    audio.currentTime = 0;
    savePosition();
    render();
  }

  function skip(sec) {
    if (!url) return;
    const dur = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.max(0, Math.min(dur, audio.currentTime + sec));
    render();
  }

  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'ended']) {
    audio.addEventListener(ev, render);
  }
  audio.addEventListener('timeupdate', savePositionSoon);
  audio.addEventListener('pause', savePosition);
  audio.addEventListener('error', () => {
    if (url) showMsg('この曲のファイルは再生できません');
  });

  $('btnSong').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    openFile(fileInput.files?.[0]);
    fileInput.value = '';
  });
  btnPlay.addEventListener('click', togglePlay);
  $('plStop').addEventListener('click', stop);
  $('plBack').addEventListener('click', () => skip(-SKIP_SEC));
  $('plFwd').addEventListener('click', () => skip(SKIP_SEC));
  $('plClose').addEventListener('click', closeSong);
  seek.addEventListener('input', () => {
    seeking = true;
    $('plTime').textContent = `${fmtTime(Number(seek.value))} / ${fmtTime(audio.duration)}`;
  });
  seek.addEventListener('change', () => {
    seeking = false;
    audio.currentTime = Number(seek.value);
    render();
  });

  // ロック画面やイヤホンのボタンからも操作できるようにする
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const handlers = {
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      stop,
      seekbackward: () => skip(-SKIP_SEC),
      seekforward: () => skip(SKIP_SEC),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* 対応していない操作は飛ばす */ }
    }
  }

  addEventListener('pagehide', savePosition);

  // 前回開いていた曲を戻す（再生はしない）
  (async () => {
    try {
      const rec = await dbGet();
      if (rec?.blob) load(rec.blob, rec.name, rec.pos || 0);
    } catch {
      // 置き場所が使えないときは、曲を開き直してもらう
    }
  })();

  return { togglePlay, skip };
}
