// ブラウザ内（localStorage）への保存。プライベートブラウズなどで使えないときは
// 保存しないだけにして、アプリは動かし続ける。

const PREFIX = 'lyricker.';

export function load(name, fallback) {
  try {
    const s = localStorage.getItem(PREFIX + name);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
