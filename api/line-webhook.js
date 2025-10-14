// api/line-webhook.js  (Vercel Serverless Function)
export const config = { runtime: 'edge' }; // 低延遲

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwjQ5iEQkytwsfo0ZhrVrXMtVmSOrQHopqvvb1mjPTw2Tv3Mbp6e8GKMVGQFWyXbIR5/exec'; // ← 換成你的 /exec

export default async function handler(req) {
  try {
    // 取得 LINE 傳來的 body（保持原樣）
    const body = await req.text();

    // 轉送到 GAS（跟著轉址直到 200）
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': req.headers.get('content-type') || 'application/json' },
      body,
      redirect: 'follow', // 若 GAS 回 302，這裡會自動跟到 200
    });

    const text = await r.text();
    // 無論 GAS 回什麼，這邊都回 200 給 LINE，避免 Verify 卡在 3xx
    return new Response(text || 'ok', { status: 200 });
  } catch (e) {
    // 即使 GAS 出錯，仍回 200，避免 Verify 失敗
    return new Response('ok', { status: 200 });
  }
}
