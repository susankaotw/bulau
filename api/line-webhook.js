// api/line-webhook.js
// LINE 綁定版：每次查詢用 LINE ID 反查 Email，再用 Email 認證/查詢 Notion
// 對應環境變數：
// - LINE_CHANNEL_ACCESS_TOKEN
// - NOTION_API_KEY 或 NOTION_TOKEN（二擇一）
// - NOTION_MEMBER_DB_ID   （會員 DB，用於 LINE 綁定與 Email 反查）
// - RECORD_DB_ID          （查詢紀錄 DB，用於寫入每次查詢與回填 AI 回覆）
// - BULAU_ANSWER_URL      （症狀查詢 API，預設 https://bulau.vercel.app/api/answer）
// - （可選）MEMBER_LINE_PROP 會員 DB 的 LINE 欄位名（預設：LINE UserId）
// - （可選）MEMBER_EMAIL_PROP 會員 DB 的 Email 欄位名（預設：Email）

const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";
const NOTION_VER = "2022-06-28";

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

const EMAIL_PROP = process.env.MEMBER_EMAIL_PROP || "Email";
const LINE_PROP  = process.env.MEMBER_LINE_PROP  || "LINE UserId"; // <== 預設已改為「LINE UserId」

// --------- 小工具 ---------
const trim    = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));

// --------- 入口 Handler ---------
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const action = String(req.query?.action || "");
      if (action === "health") {
        const health = await doHealthCheck();
        return res.status(200).json(health);
      }
      if (action === "test-write") {
        const r = await testMinimalWrite();
        return res.status(200).json(r);
      }
      return res.status(200).send("OK");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "method_not_allowed" });
    }

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) {
      try { await handleEvent(ev); }
      catch (e) { console.error("[event_error]", e); }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[handler_crash]", e);
    return res.status(200).json({ ok: false, error: e?.message || "unknown_error" });
  }
};

// --------- LINE Event Flow ---------
async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;

  const text = trim(ev.message.text);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

  // 1) 先確保取得 email（LINE userId → Email；若未綁定支援「綁定 xxx」）
  const { email, justBound, hint } = await ensureEmailForUser(userId, text);

  if (!email) {
    await replyText(replyToken, hint || "尚未綁定 Email。請輸入：綁定 your@email.com");
    return;
  }
  if (justBound) {
    await replyText(replyToken, `✅ 已綁定 Email：${email}\n之後可直接輸入症狀或關鍵字查詢。`);
  }

  // 2) Notion 記錄：寫入一筆查詢（Email + LINE UserId + 內容）
  const category = "症狀查詢";
  const content  = text;
  const pageId = await writeRecord({ email, userId, category, content });

  // 3) 呼叫 Answer API（維持你原本的 Email 驗證模式）
  const ans = await postJSON(ANSWER_URL, { q: text, question: text, email }, 15000);
  console.log("==== [Answer 原始結果(截斷)] ====");
  try { console.log(JSON.stringify(ans).slice(0, 1000)); } catch {}

  // 4) 解析 seg/tip（相容你既有欄位）
  const rawList = Array.isArray(ans?.results) ? ans.results
               : Array.isArray(ans?.items)   ? ans.items
               : [];
  const first = rawList[0] || ans?.answer || {};
  const seg = first.segments || first.segment || first["對應脊椎分節"] || "";
  const tip = first.tips     || first.summary || first.reply   || first["臨床流程建議"] || "";

  const segSafe = seg || "（無資料）";
  const tipSafe = tip || "（AI回覆空白）";

  // 5) 回填紀錄
  await patchRecordById(pageId, {
    seg: segSafe,
    tip: tipSafe,
    httpCode: String(ans?.http || 200)
  });

  // 6) 回覆使用者
  await replyText(
    replyToken,
    `✅ 已查詢：「${text}」\n對應分節：${segSafe}\nAI回覆：${tipSafe.slice(0, 500)}${tipSafe.length > 500 ? "…" : ""}`
  );
}

/* -------------------- 綁定與 Email 反查 -------------------- */
// 主流程：確保取得 Email。優先 LINE → Email；若未綁定且訊息帶「綁定 xxx」或純 Email，則嘗試首綁。
async function ensureEmailForUser(userId, text) {
  const existing = await getEmailByLineId(userId);
  if (existing) return { email: existing, justBound: false };

  let m = trim(text);
  if (/^綁定\s+/i.test(m)) m = m.replace(/^綁定\s+/i, "");
  if (isEmail(m)) {
    const ok = await bindEmailToLine(userId, m);
    if (ok) return { email: m, justBound: true };
    return { email: "", justBound: false, hint: "綁定失敗：找不到此 Email 的會員，或該帳號已綁定其他 LINE。" };
  }

  return { email: "", justBound: false, hint: "尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com" };
}

// 以 LINE userId 反查會員 Email
async function getEmailByLineId(userId) {
  if (!MEMBER_DB || !userId) return "";

  // 用 rich_text equals 查詢「LINE UserId」欄位
  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });

  if (r?.results?.length) {
    const props = r.results[0].properties || {};
    // Email 欄位建議為 Notion「Email 型別」
    const email =
      props[EMAIL_PROP]?.email ||
      // 若你的 Email 欄誤設為 Rich text，後備處理
      (props[EMAIL_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim() ||
      "";
    if (isEmail(email)) return email;
  }
  return "";
}

// 首綁：以 Email 找到會員頁 → 寫入 LINE userId 到「LINE UserId」欄（若尚未綁）
// 已綁且非同一 userId 時拒絕
async function bindEmailToLine(userId, email) {
  if (!MEMBER_DB || !userId || !isEmail(email)) return false;

  // 先用 Email 型別查
  let r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: EMAIL_PROP, email: { equals: email } },
    page_size: 1
  });
  // 後備：若 Email 欄是 Rich text
  if (!r?.results?.length) {
    r = await notionQueryDatabase(MEMBER_DB, {
      filter: { property: EMAIL_PROP, rich_text: { equals: email } },
      page_size: 1
    });
  }
  if (!r?.results?.length) return false;

  const page = r.results[0];
  const pageId = page.id;
  const props  = page.properties || {};

  // 已有綁定 → 僅允許同一 userId 視為成功；不同 userId 拒絕
  const existing = (props[LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (existing) {
    if (existing === userId) return true;
    return false;
  }

  // 寫入 LINE userId
  const ok = await notionPatchPage(pageId, {
    properties: { [LINE_PROP]: { rich_text: [{ text: { content: userId } }] } }
  });
  return ok;
}

/* -------------------- Notion：共用存取 -------------------- */
async function notionQueryDatabase(dbId, body) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });
  try { return await r.json(); } catch { return {}; }
}

async function notionPatchPage(pageId, data) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data || {})
  });
  if (!r.ok) console.error("[notionPatchPage]", r.status, await safeText(r));
  return r.ok;
}

async function notionCreatePage(dbId, properties) {
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ parent: { database_id: dbId }, properties })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error("[notionCreatePage]", r.status, j);
  return { ok: r.ok, json: j, status: r.status };
}

/* -------------------- 記錄 DB：寫入與回填 -------------------- */
async function writeRecord({ email, userId, category, content }) {
  const nowISO = new Date().toISOString();
  const nowTW  = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const props = {
    "標題":  { title: [{ text: { content: `${category}｜${nowTW}` } }] },
    "Email": { email }, // Notion「Email 型別」
    "UserId": { rich_text: [{ text: { content: userId } }] },
    "類別":  { select: { name: category } },
    "內容":  { rich_text: [{ text: { content } }] },
    "日期":  { date: { start: nowISO } },
    "來源":  { rich_text: [{ text: { content: "LINE" } }] }
  };

  const { ok, json } = await notionCreatePage(RECORD_DB, props);
  const pageId = json?.id || "";
  if (!ok) console.error("[writeRecord] create failed", json);
  return pageId;
}

async function patchRecordById(pageId, { seg, tip, httpCode }) {
  if (!pageId) return;

  const props = {};
  if (seg)     props["對應脊椎分節"] = { rich_text: [{ text: { content: String(seg).slice(0, 1900) } }] };
  if (tip)     props["AI回覆"]     = { rich_text: [{ text: { content: String(tip).slice(0, 1900) } }] };
  if (httpCode)props["API回應碼"]  = { rich_text: [{ text: { content: String(httpCode) } }] };

  const ok = await notionPatchPage(pageId, { properties: props });
  if (!ok) console.error("[patchRecordById] failed");
}

/* -------------------- LINE Reply / HTTP 工具 -------------------- */
async function replyText(replyToken, text) {
  if (!LINE_TOKEN) {
    console.warn("[replyText] missing LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text || "").slice(0, 4900) }] })
  });
  if (!r.ok) console.error("[replyText]", r.status, await safeText(r));
}

async function postJSON(url, body, timeoutMs = 15000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ac.signal
    });
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    json.http = r.status;
    return json;
  } catch (e) {
    console.error("[postJSON]", e?.message || e);
    return { ok: false, error: e?.message || "fetch_failed" };
  } finally {
    clearTimeout(id);
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

/* -------------------- 健康檢查 & 最小寫入 -------------------- */
// GET /api/line-webhook?action=health
async function doHealthCheck() {
  const hasNotionKey = Boolean(NOTION_KEY);
  const hasMemberDB  = Boolean(MEMBER_DB);
  const hasRecordDB  = Boolean(RECORD_DB);

  // 嘗試查會員 DB（不帶條件）
  let memQueryOk = false;
  if (hasNotionKey && hasMemberDB) {
    const r = await notionQueryDatabase(MEMBER_DB, { page_size: 1 });
    memQueryOk = !!(r && (Array.isArray(r.results)));
  }

  return {
    ok: hasNotionKey && hasMemberDB && hasRecordDB,
    hasNotionKey,
    hasMemberDB,
    hasRecordDB,
    memQueryOk,
    memberLineProp: LINE_PROP,
    memberEmailProp: EMAIL_PROP
  };
}

// GET /api/line-webhook?action=test-write
async function testMinimalWrite() {
  if (!RECORD_DB) return { ok: false, reason: "missing RECORD_DB_ID" };
  const nowTW = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const props = {
    "標題":  { title: [{ text: { content: `最小寫入測試｜${nowTW}` } }] },
    "Email": { email: "test@example.com" },
    "UserId": { rich_text: [{ text: { content: "TEST_LINE_USER_ID" } }] },
    "類別":  { select: { name: "系統測試" } },
    "內容":  { rich_text: [{ text: { content: "這是 /api/line-webhook?action=test-write 產生的測試頁" } }] },
    "來源":  { rich_text: [{ text: { content: "LINE" } }] }
  };

  const { ok, json, status } = await notionCreatePage(RECORD_DB, props);
  return { ok, status, pageId: json?.id || null };
}
