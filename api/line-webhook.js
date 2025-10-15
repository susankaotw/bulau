// api/line-webhook.js — Production-ready
// 功能：debug/echo、以 uid 綁定 email（/api/guard）、症狀查詢（/api/answer）、背景寫 Notion
// 重點：LINE token 在函式內「執行時」讀、相容 NOTION_API_KEY / NOTION_TOKEN、CJS + ESM 匯出

const GUARD_URL  = process.env.BULAU_GUARD_URL  || "https://bulau.vercel.app/api/guard";
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";

async function handler(req, res) {
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      return res.status(200).send("OK");
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "method_not_allowed" });
    }

    // 解析 body；有時 req.body 是字串或空
    let body = req.body;
    if (!body || typeof body === "string") {
      let raw = typeof body === "string" ? body : await readRaw(req).catch(() => "");
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    if (!events.length) return res.status(200).json({ ok: true, note: "no_events" });

    // 等每則處理完再回 200，避免 Vercel 提早結束執行環境
    for (const ev of events) {
      await handleEvent(ev).catch(e => console.error("[event_error]", e?.message || e));
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e?.stack || e?.message || e);
    return res.status(200).json({ ok: false, note: "handled" });
  }
}

async function handleEvent(ev) {
  if (ev?.type !== "message" || ev?.message?.type !== "text") return;

  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";
  const rawText = String(ev.message?.text || "");
  const q = normalize(rawText);

  // 0) debug：直接回環境檢查（不用看 logs）
  if (/^debug$/i.test(q)) {
    const msg = renderEnvDiag();
    await replyOrPush(replyToken, userId, msg);
    return;
  }

  // 1) 以 userId 換 email（/api/guard）
  const guard = await postJSON(GUARD_URL, { uid: userId }, 3500);
  const email = guard?.ok && guard?.email ? String(guard.email).trim().toLowerCase() : "";
  if (!email) {
    await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
    return;
  }

  // 2) 查症狀（/api/answer）— 同送 q & question 以相容不同欄位
  const ans = await postJSON(ANSWER_URL, { q, question: q, email }, 5000);
  const results = Array.isArray(ans?.results) ? ans.results : [];

  let seg = "—", tip = "—", mer = "—", replyMsg = "";
  if (results.length) {
    const r = results[0] || {};
    seg = r.segments || r.segment || "—";
    tip = r.tips || r.summary || r.reply || "—";
    mer = (Array.isArray(r.meridians) && r.meridians.length) ? r.meridians.join("、") : "—";
    replyMsg = `🔎 查詢：「${q}」\n對應脊椎分節：${seg}\n經絡與補充：${mer}\n教材重點：${tip}`;
  } else if (ans?.answer?.臨床流程建議) { // 舊版格式相容
    seg = ans.answer.對應脊椎分節 || "—";
    tip = ans.answer.臨床流程建議 || "—";
    replyMsg = `🔎 查詢：「${q}」\n建議分節：${seg}\n臨床流程：${tip}`;
  } else {
    replyMsg = `找不到「${q}」的教材內容。\n可改試：肩頸、頭暈、胸悶、胃痛、腰痠。`;
  }

  // 3) 回覆（reply 失敗則自動改用 push 備援）
  await replyOrPush(replyToken, userId, replyMsg);

  // 4) 背景寫 Notion（有設定才寫；不中斷主流程）
  const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const RECORD_DB_ID = process.env.RECORD_DB_ID || "";
  if (NOTION_KEY && RECORD_DB_ID) {
    writeRecord({
      email, userId, category: "症狀查詢", content: rawText,
      seg, tip, statusCode: typeof ans?.http === "number" ? String(ans.http) : "200",
      NOTION_KEY, RECORD_DB_ID
    }).catch(e => console.error("[writeRecord]", e?.message || e));
  }
}

/* ---------- Utilities ---------- */

function normalize(s) {
  if (!s) return "";
  let t = String(s).replace(/\u3000/g, " ").replace(/\s+/g, "");
  if (t === "肩") t = "肩頸";
  return t;
}

function readRaw(req) {
  return new Promise((resolve) => {
    let data = ""; req.on("data", c => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

async function postJSON(url, body, timeoutMs = 5000) {
  const ac = new AbortController(); const id = setTimeout(() => ac.abort(), timeoutMs);
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
    console.error("[postJSON_error]", url, e?.message || e);
    return { ok: false, error: "fetch_failed" };
  } finally { clearTimeout(id); }
}

async function replyOrPush(replyToken, userId, text) {
  const ok = await replyText(replyToken, text);
  if (!ok && userId) await pushText(userId, text);
}

async function replyText(replyToken, text) {
  // 執行時讀取，避免載入時被固定成空
  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text).slice(0, 4900) }] })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[replyText] http", r.status, t, "len=", LINE_TOKEN.length);
      return false;
    }
    console.log("[replyText] ok len=", LINE_TOKEN.length);
    return true;
  } catch (e) {
    console.error("[replyText_error]", e?.message || e);
    return false;
  }
}

async function pushText(to, text) {
  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text: String(text).slice(0, 4900) }] })
    });
    if (!r.ok) console.error("[pushText] http", r.status, await r.text(), "len=", LINE_TOKEN.length);
    else console.log("[pushText] ok len=", LINE_TOKEN.length);
  } catch (e) { console.error("[pushText_error]", e?.message || e); }
}

function renderEnvDiag() {
  const lineLen = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").length;
  const keysLikeLine = Object.keys(process.env).filter(k => k.includes("LINE")).slice(0, 20);
  const hasGuard  = !!process.env.BULAU_GUARD_URL;
  const hasAnswer = !!process.env.BULAU_ANSWER_URL;
  const hasNotion = !!(process.env.NOTION_API_KEY || process.env.NOTION_TOKEN);
  const hasRecord = !!process.env.RECORD_DB_ID;
  return [
    "🔧 環境檢查",
    `LINE_TOKEN 長度：${lineLen}`,
    `有 GUARD_URL：${hasGuard}`,
    `有 ANSWER_URL：${hasAnswer}`,
    `有 NOTION_KEY：${hasNotion}`,
    `有 RECORD_DB_ID：${hasRecord}`,
    `keys(含 LINE)：${keysLikeLine.join(", ") || "—"}`
  ].join("\n");
}

async function writeRecord({ email, userId, category, content, seg, tip, statusCode, NOTION_KEY, RECORD_DB_ID }) {
  const nowISO = new Date().toISOString();
  const payload = {
    parent: { database_id: RECORD_DB_ID },
    properties: {
      "標題": { title: [{ text: { content: `症狀查詢｜${new Date(nowISO).toLocaleString("zh-TW",{ timeZone:"Asia/Taipei" })}` } }] },
      "Email": { email },
      "UserId": { rich_text: [{ text: { content: userId } }] },
      "類別": { select: { name: category } },
      "內容": { rich_text: [{ text: { content: content } }] },
      "日期": { date: { start: nowISO } },
      "來源": { rich_text: [{ text: { content: "LINE" } }] },
      ...(seg ? { "對應脊椎分節": { rich_text: [{ text: { content: seg } }] } } : {}),
      ...(tip ? { "AI回覆": { rich_text: [{ text: { content: String(tip).slice(0, 2000) } }] } } : {}),
      ...(statusCode ? { "API回應碼": { rich_text: [{ text: { content: statusCode } }] } } : {})
    }
  };
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) console.error("[notion create] http", r.status, await r.text());
  else console.log("[notion create] ok");
}

/* 同時支援 CJS / ESM 匯出（避免 package.json 的 "type" 影響） */
module.exports = handler;
export default handler;
