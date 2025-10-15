// api/line-webhook.js
// Vercel Serverless Function 版本（非 Next.js App Router）

const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GUARD_URL    = process.env.BULAU_GUARD_URL || "https://bulau.vercel.app/api/guard";
const ANSWER_URL   = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_TOKEN = process.env.NOTION_API_KEY;     // 可省略，未設定就不寫 Notion
const RECORD_DB_ID = process.env.RECORD_DB_ID;       // 可省略，未設定就不寫 Notion

module.exports = async (req, res) => {
  // 1) LINE 的 Verify 可能發 GET，回 200 立刻通過
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }

  // 2) 只接受 POST
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "method_not_allowed" });
  }

  try {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : [];

    // 3) 逐則處理（不要阻塞回應）
    const tasks = events.map(ev => handleEvent(ev).catch(err => {
      console.error("[handleEvent]", err && (err.stack || err.message || err));
    }));

    // 不要等待所有外部 I/O 完成（避免超時），我們只要確保有啟動處理即可
    // Promise.allSettled(tasks) 會等完，這裡不要 await
    // 直接回 200，讓 LINE 不會 timeout
    res.status(200).json({ ok: true });

  } catch (e) {
    console.error("[webhook] error", e && (e.stack || e.message || e));
    // 仍回 200，避免 LINE 重送
    res.status(200).json({ ok: false });
  }
};

async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;

  const replyToken = ev.replyToken;
  const userId     = ev.source?.userId || "";
  const textRaw    = ev.message?.text || "";
  const q          = normalize(textRaw);

  // 1) 以 userId 透過 /api/guard 拿 email
  const guard = await postJSON(GUARD_URL, { uid: userId }, 2500);
  const email = (guard && guard.ok && guard.email) ? String(guard.email).trim().toLowerCase() : "";

  if (!email) {
    await replyText(replyToken, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
    return;
  }

  // 2) 查答案（同送 q & question，避免欄位名不合）
  const ans = await postJSON(ANSWER_URL, { q, question: q, email }, 4000);
  const results = Array.isArray(ans?.results) ? ans.results : [];

  let msg = "";
  let seg = "—";
  let tip = "—";
  let mer = "—";

  if (results.length) {
    const r = results[0] || {};
    seg = r.segments || r.segment || "—";
    tip = r.tips || r.summary || r.reply || "—";
    mer = (Array.isArray(r.meridians) && r.meridians.length) ? r.meridians.join("、") : "—";
    msg = [
      `🔎 查詢：「${q}」`,
      `對應脊椎分節：${seg}`,
      `經絡與補充：${mer}`,
      `教材重點：${tip}`
    ].join("\n");
  } else if (ans?.answer?.臨床流程建議) {
    seg = ans.answer.對應脊椎分節 || "—";
    tip = ans.answer.臨床流程建議 || "—";
    msg = `🔎 查詢：「${q}」\n建議分節：${seg}\n臨床流程：${tip}`;
  } else {
    msg = `找不到「${q}」的教材內容。\n可改試：肩頸、頭暈、胸悶、胃痛、腰痠。`;
  }

  // 3) 先回使用者（reply）
  await replyText(replyToken, msg);

  // 4) 背景寫 Notion（未設定金鑰/DB 就略過）
  if (NOTION_TOKEN && RECORD_DB_ID) {
    writeRecord({
      email, userId, category: "症狀查詢", content: textRaw,
      seg, tip, statusCode: typeof ans?.http === "number" ? String(ans.http) : "200"
    }).catch(e => console.error("[writeRecord]", e && (e.stack || e.message || e)));
  }
}

/** 工具：字串正規化 */
function normalize(s) {
  if (!s) return "";
  let t = String(s).replace(/\u3000/g, " ").replace(/\s+/g, "");
  if (t === "肩") t = "肩頸";
  return t;
}

/** 工具：有逾時的 fetch JSON */
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
    if (!r.ok) json.http = r.status;
    return json;
  } finally {
    clearTimeout(id);
  }
}

/** 工具：回覆 LINE 訊息 */
async function replyText(replyToken, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: String(text).slice(0, 4900) }]
    })
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("[replyText] http", r.status, t);
  }
}

/** 背景寫 Notion（不阻塞回覆） */
async function writeRecord(opts) {
  const nowISO = new Date().toISOString();
  const payload = {
    parent: { database_id: RECORD_DB_ID },
    properties: {
      "標題": { title: [{ text: { content: `症狀查詢｜${toTW(nowISO)}` } }] },
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

  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("[notion create] http", r.status, t);
  }
}

function toTW(iso) {
  try {
    return new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  } catch { return iso; }
}
