// api/line-webhook.js
// Debug 版：追蹤「AI回覆 / 對應脊椎分節」未寫入原因
// ---------------------------------------------------------

const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const NOTION_VER = "2022-06-28";

/* --------------------------- 主入口 --------------------------- */
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") return res.status(200).send("OK");
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "method_not_allowed" });

    const body = req.body;
    const events = Array.isArray(body?.events) ? body.events : [];
    for (const ev of events) await handleEvent(ev).catch(e => console.error("[event_error]", e));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e);
    res.status(200).json({ ok: false, error: e.message });
  }
};

/* --------------------------- 處理事件 --------------------------- */
async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message.type !== "text") return;
  const text = ev.message.text.trim();
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

  // === 1️⃣ 一般查詢 ===
  const content = text;
  const category = "症狀查詢";
  const email = "test@example.com"; // 測試用，實際會取會員表

  // 建立記錄
  const pageId = await writeRecord({ email, userId, category, content });

  // 呼叫 Answer API
  const ans = await postJSON(ANSWER_URL, { q: text, question: text, email }, 6000);
  console.log("==== [Answer 原始結果前 800 字] ====");
  console.log(JSON.stringify(ans).slice(0, 800));

  // 解析 seg / tip
  const rawList = Array.isArray(ans?.results) ? ans.results :
                  Array.isArray(ans?.items) ? ans.items : [];
  const first = rawList[0] || ans?.answer || {};
  const seg = first.segments || first.segment || first["對應脊椎分節"] || "";
  const tip = first.tips || first.summary || first.reply || first["臨床流程建議"] || "";

  console.log("[解析結果] seg =", seg, " | tip =", tip);

  // 若 seg/tip 皆空，補上測試值以確認 patch 有執行
  const segSafe = seg || "（無資料）";
  const tipSafe = tip || "（AI回覆空白）";

  await patchRecordById(pageId, { seg: segSafe, tip: tipSafe, httpCode: String(ans?.http || 200) });
  await replyText(replyToken, `✅ 已查詢：「${text}」\n對應分節=${segSafe}\nAI回覆=${tipSafe.slice(0,60)}`);
}

/* --------------------------- Notion 寫入 --------------------------- */
async function writeRecord({ email, userId, category, content }) {
  const now = new Date().toISOString();
  const props = {
    "標題":  { title: [{ text: { content: `${category}｜${new Date().toLocaleString("zh-TW",{ timeZone:"Asia/Taipei" })}` } }] },
    "Email": { email },
    "UserId": { rich_text: [{ text: { content: userId } }] },
    "類別":  { select: { name: category } },
    "內容":  { rich_text: [{ text: { content } }] },
    "日期":  { date: { start: now } },
    "來源":  { rich_text: [{ text: { content: "LINE" } }] }
  };

  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ parent: { database_id: RECORD_DB }, properties: props })
  });
  const j = await r.json();
  console.log("[writeRecord]", r.status, j.id);
  return j.id;
}

/* --------------------------- Notion 回填 --------------------------- */
async function patchRecordById(pageId, { seg, tip, httpCode }) {
  const props = {
    ...(seg ? { "對應脊椎分節": { rich_text: [{ text: { content: seg } }] } } : {}),
    ...(tip ? { "AI回覆": { rich_text: [{ text: { content: tip.slice(0,1900) } }] } } : {}),
    ...(httpCode ? { "API回應碼": { rich_text: [{ text: { content: String(httpCode) } }] } } : {})
  };
  console.log("[patch props]", JSON.stringify(props, null, 2));

  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ properties: props })
  });
  if (!r.ok) console.error("[patchRecordById] http", r.status, await r.text());
}

/* --------------------------- LINE Reply --------------------------- */
async function replyText(replyToken, text) {
  const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
  if (!r.ok) console.error("[replyText] http", r.status, await r.text());
}

/* --------------------------- 工具 --------------------------- */
async function postJSON(url, body, timeoutMs = 5000) {
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
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    json.http = r.status;
    return json;
  } catch (e) {
    console.error("[postJSON]", e);
    return { ok: false, error: e.message || "fetch_failed" };
  } finally { clearTimeout(id); }
}
