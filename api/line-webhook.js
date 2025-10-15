// api/line-webhook.js
// ————————————————
// 相容雙版本環境變數的 LINE Webhook：
// - NOTION_KEY = NOTION_API_KEY || NOTION_TOKEN
// - 有 /api/guard 取 email、有 /api/answer 查教材
// - 先 reply 再背景寫 Notion（若未設定 NOTION_KEY/RECORD_DB_ID 就自動略過）
// ————————————————

/** ===== Env (相容雙命名) ===== */
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const GUARD_URL    = process.env.BULAU_GUARD_URL  || "https://bulau.vercel.app/api/guard";
const ANSWER_URL   = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || ""; // ← 統一用這個
const RECORD_DB_ID = process.env.RECORD_DB_ID || "";

/** ===== Handler ===== */
async function handler(req, res) {
  try {
    if (req.method === "GET") return res.status(200).send("OK");
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "method_not_allowed" });

    // 健檢（不印 token 值，只印長度）
    console.log("[env-check]", {
      line_token_len: LINE_TOKEN ? LINE_TOKEN.length : 0,
      has_guard: !!GUARD_URL,
      has_answer: !!ANSWER_URL,
      has_notion_key: !!NOTION_KEY,
      has_record_db: !!RECORD_DB_ID
    });

    // 解析 body（避免某些平台 req.body 為字串或空）
    let body = req.body;
    if (!body || typeof body === "string") {
      let raw = typeof body === "string" ? body : await readRawBody(req).catch(() => "");
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    console.log("[webhook] events =", events.length);
    if (!events.length) return res.status(200).json({ ok: true, note: "no_events" });

    // 等每則處理完成再回 200（避免 Vercel 終止環境）
    for (const ev of events) {
      await handleEvent(ev).catch(e => console.error("[event_error]", e?.message || e));
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e?.stack || e?.message || e);
    return res.status(200).json({ ok: false });
  }
}

/** ===== 單則事件 ===== */
async function handleEvent(ev) {
  console.log("[event]", ev?.type, ev?.source?.userId, ev?.message?.type, ev?.message?.text);
  if (ev?.type !== "message" || ev?.message?.type !== "text") return;

  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";
  const textRaw = String(ev.message?.text || "");
  const q = normalize(textRaw);

  // 1) 以 userId → /api/guard 取得 email
  const guard = await safePostJSON(GUARD_URL, { uid: userId }, 3500);
  const email = guard?.ok && guard?.email ? String(guard.email).trim().toLowerCase() : "";
  if (!email) {
    await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
    return;
  }

  // 2) 查答案（同送 q & question，避免欄位名差異）
  const ans = await safePostJSON(ANSWER_URL, { q, question: q, email }, 5000);
  const results = Array.isArray(ans?.results) ? ans.results : [];

  let msg = "";
  let seg = "—", tip = "—", mer = "—";

  if (results.length) {
    const r = results[0] || {};
    seg = r.segments || r.segment || "—";
    tip = r.tips || r.summary || r.reply || "—";
    mer = (Array.isArray(r.meridians) && r.meridians.length) ? r.meridians.join("、") : "—";
    msg = `🔎 查詢：「${q}」\n對應脊椎分節：${seg}\n經絡與補充：${mer}\n教材重點：${tip}`;
  } else if (ans?.answer?.臨床流程建議) {
    seg = ans.answer.對應脊椎分節 || "—";
    tip = ans.answer.臨床流程建議 || "—";
    msg = `🔎 查詢：「${q}」\n建議分節：${seg}\n臨床流程：${tip}`;
  } else {
    msg = `找不到「${q}」的教材內容。\n可改試：肩頸、頭暈、胸悶、胃痛、腰痠。`;
  }

  // 3) 回覆（若 reply 失敗則 push 備援）
  await replyOrPush(replyToken, userId, msg);

  // 4) 背景寫 Notion（未設金鑰/DB 就自動略過）
  if (NOTION_KEY && RECORD_DB_ID) {
    void writeRecord({
      email, userId, category: "症狀查詢", content: textRaw,
      seg, tip, statusCode: typeof ans?.http === "number" ? String(ans.http) : "200"
    }).catch(e => console.error("[writeRecord]", e?.message || e));
  }
}

/** ===== Utils ===== */
function normalize(s) {
  if (!s) return "";
  let t = String(s).replace(/\u3000/g, " ").replace(/\s+/g, "");
  if (t === "肩") t = "肩頸";
  return t;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function safePostJSON(url, body, timeoutMs = 5000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!r.ok) json.http = r.status;
    return json;
  } catch (e) {
    console.error("[safePostJSON_error]", url, e?.message || e);
    return { ok: false, error: "fetch_failed" };
  } finally { clearTimeout(id); }
}

async function replyOrPush(replyToken, userId, text) {
  const ok = await replyText(replyToken, text);
  if (!ok && userId) await pushText(userId, text);
}

async function replyText(replyToken, text) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text).slice(0, 4900) }] })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[replyText] http", r.status, t);
      return false;
    }
    console.log("[replyText] ok");
    return true;
  } catch (e) {
    console.error("[replyText_error]", e?.message || e);
    return false;
  }
}

async function pushText(to, text) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text: String(text).slice(0, 4900) }] })
    });
    if (!r.ok) console.error("[pushText] http", r.status, await r.text());
    else console.log("[pushText] ok");
  } catch (e) {
    console.error("[pushText_error]", e?.message || e);
  }
}

/** ===== Notion: create record（用 NOTION_KEY，不分 API_KEY / TOKEN） ===== */
async function writeRecord(opts) {
  const nowISO = new Date().toISOString();
  const payload = {
    parent: { database_id: RECORD_DB_ID },
    properties: {
      "標題": { title: [{ text: { content: `症狀查詢｜${new Date(nowISO).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}` } }] },
      "Email": { email: opts.email },
      "UserId": { rich_text: [{ text: { content: opts.userId } }] },
      "類別": { select: { name: opts.category } },
      "內容": { rich_text: [{ text: { content: opts.content } }] },
      "日期": { date: { start: nowISO } },
      "來源": { rich_text: [{ text: { content: "LINE" } }] },
      ...(opts.seg ? { "對應脊椎分節": { rich_text: [{ text: { content: opts.seg } }] } } : {}),
      ...(opts.tip ? { "AI回覆": { rich_text: [{ text: { content: String(opts.tip).slice(0, 2000) } }] } } : {}),
      ...(opts.statusCode ? { "API回應碼": { rich_text: [{ text: { content: opts.statusCode } }] } } : {})
    }
  };

  try {
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_KEY}`,         // ← 這裡用統一的 NOTION_KEY
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.error("[notion create] http", r.status, await r.text());
    else console.log("[notion create] ok");
  } catch (e) {
    console.error("[writeRecord_error]", e?.message || e);
  }
}

/** 同時支援 CJS/ESM 匯出，避免 package.json 的 "type" 影響 */
module.exports = handler;
export default handler;
