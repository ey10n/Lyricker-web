// Google Gemini API（generativelanguage.googleapis.com）。
//
// APIキーは Google AI Studio（https://aistudio.google.com/api-keys）で発行する。
// 無償枠で使えるモデルは時期によって変わるので、既定は最新の Flash を指す
// 別名 gemini-flash-latest にしておき、具体的なモデルは一覧から選べるようにする。

import { AIError, fetchOrFail, registerProvider, sleep } from './ai.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/';
// 混雑（500/503）のときに、やり直す前に待つ時間。要素数がやり直しの回数
const RETRY_WAITS_MS = [2000, 5000, 10000];

async function errorFromResponse(res, model) {
  let msg = '';
  const body = await res.text();
  try {
    msg = JSON.parse(body)?.error?.message || '';
  } catch {
    msg = body.slice(0, 300);
  }
  switch (res.status) {
    case 400:
    case 401:
    case 403:
      if (/API key/i.test(msg)) msg = 'APIキーが正しくありません。\n' + msg;
      break;
    case 404:
      msg = `モデル「${model}」が見つかりません。モデル一覧から選び直してください。\n` + msg;
      break;
    case 429:
      msg = '利用上限に達しました。しばらく待つか、別のモデルを選んでください。\n' + msg;
      break;
    case 500:
    case 503:
      msg = 'Gemini が混み合っています（何度かやり直しましたが、つながりませんでした）。\n' +
        'しばらく待ってから実行するか、別のモデルを選んでください。\n' + msg;
      break;
  }
  return new AIError(`Gemini API エラー (${res.status})\n${msg}`);
}

const gemini = {
  id: 'gemini',
  displayName: 'Gemini',
  defaultModel: 'gemini-flash-latest',
  keyHelp: 'Google AI Studio（<a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener">aistudio.google.com/api-keys</a>）で無料で発行できます。',

  async generate({ apiKey, model, prompt, signal }) {
    if (!apiKey) throw new AIError('Gemini の APIキーが設定されていません。');
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchOrFail(`${BASE_URL}models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal,
      });
      if ((res.status !== 500 && res.status !== 503) || attempt >= RETRY_WAITS_MS.length) break;
      await sleep(RETRY_WAITS_MS[attempt], signal);
    }
    if (!res.ok) throw await errorFromResponse(res, model);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new AIError('Gemini の応答を読み取れませんでした。');
    }
    // 思考過程（thought）は本文に含めない
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text) {
      // 安全性フィルタなどで止められた場合は理由を返す
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || '';
      throw new AIError('Gemini から本文が返りませんでした。\n理由: ' + reason);
    }
    return text;
  },

  async listModels({ apiKey, signal }) {
    if (!apiKey) throw new AIError('Gemini の APIキーが設定されていません。');
    const res = await fetchOrFail(`${BASE_URL}models?pageSize=1000`, {
      headers: { 'x-goog-api-key': apiKey },
      signal,
    });
    if (!res.ok) throw await errorFromResponse(res, '');
    const data = await res.json();
    const names = (data.models || [])
      // 文章生成に使えるものだけ（埋め込み用などは除く）
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => name.startsWith('gemini'));
    if (!names.includes(gemini.defaultModel)) names.unshift(gemini.defaultModel);
    return names;
  },
};

registerProvider(gemini);
