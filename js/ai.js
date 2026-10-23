// AI サービスの共通の窓口。
//
// サービスごとに下の形のオブジェクトを作って registerProvider する。
// 画面側は登録された一覧から選ぶだけなので、新しい AI を足すときに画面のコードを変えなくてよい。
//
//   {
//     id: 'gemini',                 設定の保存に使う識別子（英小文字）
//     displayName: 'Gemini',        画面に出す名前
//     defaultModel: '...',
//     keyHelp: '...',               APIキーの入手先などの案内（HTML 可）
//     async generate({ apiKey, model, prompt, signal }) → 応答の本文
//     async listModels({ apiKey, signal }) → モデル名の配列
//   }
//
// 失敗したときは AIError（画面にそのまま出せる日本語のメッセージ）を投げる。

export class AIError extends Error {}

const providers = [];

export function registerProvider(provider) {
  providers.push(provider);
}

export function getProviders() {
  return providers;
}

export function findProvider(id) {
  return providers.find((p) => p.id === id) || null;
}

/** fetch の失敗（通信できない）を読みやすいエラーにする */
export async function fetchOrFail(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AIError('通信できませんでした。インターネット接続を確認してください。\n' + e.message);
  }
}

/** 中止（signal）にも反応する待ち */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('中止しました', 'AbortError'));
    }, { once: true });
  });
}
