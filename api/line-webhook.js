// api/line-webhook.js
// 功能總覽：
// 1) 綁定：  「綁定 you@mail.com」 → 將此 LINE userId 綁到會員 Email 頁面（欄位：LINE UserId）
// 2) 狀態：  「我的狀態」/「狀態」 → 回報 會員狀態/等級/有效日期/綁定情況
// 3) 簽到：  「簽到」 或 「簽到 內容」 → 寫入查詢紀錄 DB（類別=簽到）
// 4) 心得：  「心得 文字……」       → 寫入查詢紀錄 DB（類別=心得）
// 5) 症狀查詢：任意關鍵字（如「肩頸痠痛」）→ 呼叫 ANSWER_URL，回填「對應脊椎分節」「AI回覆」
//
// 必要環境變數：
// - LINE_CHANNEL_ACCESS_TOKEN
// - NOTION_API_KEY 或 NOTION_TOKEN（二擇一）
// - NOTION_MEMBER_DB_ID   （會員 DB，用於 LINE 綁定與 Email 反查）
// - RECORD_DB_ID          （通用紀錄 DB，用於簽到/心得/症狀查詢紀錄）
// - BULAU_ANSWER_URL      （症狀查詢 API，預設 https://bulau.vercel.app/api/answer）
// 可選覆寫：
// - MEMBER_LINE_PROP  (預設: "LINE UserId")
// - MEMBER_EMAIL_PROP (預設: "Email")

const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";
const NOTION_VER = "2022-06-28";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

const EMAIL_PROP = process.env.MEMBER_EMAIL_PROP || "Email";
const LINE_PROP  = process.env.MEMBER_LINE_PROP  || "LINE UserId"; // << 你的欄位名

// 工具
const trim = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));

// 入口
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const action = String(req.query?.action || "");
      if (action === "health")  return res.status(200).json(await doHealthCheck());
      if (action === "test-write") return res.status(200).json(await testMinimalWrite());
      return res.status(200).send("OK");
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, reason:"method_not_allowed" });
    }

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) {
      try { await handleEvent(ev); } catch(e) { console.error("[event_error]", e); }
    }
    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error("[handler_crash]", e);
    return res.status(200).json({ ok:false, error: e?.message || "unknown_error" });
  }
};

// 主流程
async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const text = trim(ev.message.text);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

  // 指令路由
  if (/^(help|幫助|\?|指令)$/i.test(text)) {
    await replyText(replyToken, helpText());
    return;
  }

  // 綁定
  if (/^綁定\s+/i.test(text) || isEmail(text)) {
    let email = text;
    if (/^綁定\s+/i.test(email)) email = trim(email.replace(/^綁定\s+/i, ""));
    if (!isEmail(email)) {
      await replyText(replyToken, "請輸入正確 Email，例如：綁定 test@example.com");
      return;
    }
    const ok = await bindEmailToLine(userId, email);
    if (!ok) {
      await replyText(replyToken, "綁定失敗：找不到此 Email 的會員，或該帳號已綁定其他 LINE。");
      return;
    }
    await replyText(replyToken, `✅ 已綁定 Email：${email}\n之後可直接輸入關鍵字查詢、簽到或寫心得。`);
    return;
  }

  // 狀態
  if (/^(我的)?狀態$/i.test(text)) {
    const info = await getMemberInfoByLineId(userId);
    if (!info) {
      await replyText(replyToken, "尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com");
      return;
    }
    const { email, status, level, expire, lineBind } = info;
    const expText = expire ? fmtDate(expire) : "（未設定）";
    await replyText(
      replyToken,
      `📇 會員狀態\nEmail：${email}\n狀態：${status || "（未設定）"}\n等級：${level || "（未設定）"}\n有效日期：${expText}\nLINE 綁定：${lineBind || "（未設定）"}`
    );
    return;
  }

  // 簽到
  if (/^簽到\b/.test(text) || /^打卡\b/.test(text)) {
    const ensured = await ensureEmailForUser(userId);
    if (!ensured.email) {
      await replyText(replyToken, ensured.hint || "尚未綁定 Email。請輸入：綁定 your@email.com");
      return;
    }
    const content = trim(text.replace(/^(簽到|打卡)\s*/,"")) || "簽到";
    const pageId = await writeRecord({
      email: ensured.email, userId, category: "簽到", content
    });
    await replyText(replyToken, `✅ 已簽到！\n內容：${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  // 心得
  if (/^心得\b/.test(text)) {
    const ensured = await ensureEmailForUser(userId);
    if (!ensured.email) {
      await replyText(replyToken, ensured.hint || "尚未綁定 Email。請輸入：綁定 your@email.com");
      return;
    }
    const content = trim(text.replace(/^心得\s*/,""));
    if (!content) {
      await replyText(replyToken, "請在「心得」後面接文字，例如：心得 今天的頸胸交界手感更清楚了");
      return;
    }
    const pageId = await writeRecord({
      email: ensured.email, userId, category: "心得", content
    });
    await replyText(replyToken, `📝 已寫入心得！\n${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  // 其餘 → 症狀查詢（AI）
  const ensured = await ensureEmailForUser(userId);
  if (!ensured.email) {
    await replyText(replyToken, ensured.hint || "尚未綁定 Email。請輸入：綁定 your@email.com");
    return;
  }

  const category = "症狀查詢";
  const content  = text;
  const pageId = await writeRecord({ email: ensured.email, userId, category, content });

  const ans = await postJSON(ANSWER_URL, { q: text, question: text, email: ensured.email }, 15000);
  console.log("==== [Answer 原始結果(截斷)] ====");
  try { console.log(JSON.stringify(ans).slice(0, 1000)); } catch {}

  const rawList = Array.isArray(ans?.results) ? ans.results
               : Array.isArray(ans?.items)   ? ans.items
               : [];
  const first = rawList[0] || ans?.answer || {};
  const seg = first.segments || first.segment || first["對應脊椎分節"] || "";
  const tip = first.tips     || first.summary || first.reply   || first["臨床流程建議"] || "";

  const segSafe = seg || "（無資料）";
  const tipSafe = tip || "（AI回覆空白）";

  await patchRecordById(pageId, {
    seg: segSafe,
    tip: tipSafe,
    httpCode: String(ans?.http || 200)
  });

  await replyText(
    replyToken,
    `✅ 已查詢：「${text}」\n對應分節：${segSafe}\nAI回覆：${tipSafe.slice(0, 500)}${tipSafe.length > 500 ? "…" : ""}`
  );
}

/* ---------- 綁定 / 會員查詢 ---------- */
// 確保 Email（若未綁定則回提示）
async function ensureEmailForUser(userId) {
  const email = await getEmailByLineId(userId);
  if (email) return { email, justBound:false };
  return {
    email: "",
    justBound: false,
    hint: "尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com"
  };
}

// 以 LINE userId 反查 Email
async function getEmailByLineId(userId) {
  if (!MEMBER_DB || !userId) return "";
  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });
  if (r?.results?.length) {
    const p = r.results[0].properties || {};
    const email = p[EMAIL_PROP]?.email
      || (p[EMAIL_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim()
      || "";
    return isEmail(email) ? email : "";
  }
  return "";
}

// 取完整會員資訊（Email、狀態、等級、有效日期、LINE 綁定）
async function getMemberInfoByLineId(userId) {
  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });
  if (!r?.results?.length) return null;

  const page = r.results[0];
  const p = page.properties || {};
  const email = p[EMAIL_PROP]?.email
    || (p[EMAIL_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim()
    || "";
  const status = p["狀態"]?.select?.name || "";
  const level  = p["等級"]?.select?.name || "";
  const expire = p["有效日期"]?.date?.start || "";
  const lineBind = (p[LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();

  return { email, status, level, expire, lineBind };
}

// 首綁：以 Email 找會員 → 寫入 LINE userId（若未綁）
// 已綁且非同一 userId 時拒絕
async function bindEmailToLine(userId, email) {
  if (!MEMBER_DB || !userId || !isEmail(email)) return false;

  // 先用 Email 型別
  let r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: EMAIL_PROP, email: { equals: email } },
    page_size: 1
  });
  // 後備：若 Email 欄是 rich_text
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
  const existing = (props[LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (existing) {
    if (existing === userId) return true; // 已是同一人
    return false; // 已綁別人
  }

  const ok = await notionPatchPage(pageId, {
    properties: { [LINE_PROP]: { rich_text: [{ text: { content: userId } }] } }
  });
  return ok;
}

/* ---------- Notion：共用 ---------- */
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

/* ---------- 紀錄 DB：簽到/心得/症狀 ---------- */
async function writeRecord({ email, userId, category, content }) {
  const nowISO = new Date().toISOString();
  const nowTW  = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const props = {
    "標題":  { title: [{ text: { content: `${category}｜${nowTW}` } }] },
    "Email": { email }, // Email 型別
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
  if (seg)      props["對應脊椎分節"] = { rich_text: [{ text: { content: String(seg).slice(0,1900) } }] };
  if (tip)      props["AI回覆"]     = { rich_text: [{ text: { content: String(tip).slice(0,1900) } }] };
  if (httpCode) props["API回應碼"]  = { rich_text: [{ text: { content: String(httpCode) } }] };

  const ok = await notionPatchPage(pageId, { properties: props });
  if (!ok) console.error("[patchRecordById] failed");
}

/* ---------- LINE / HTTP 工具 ---------- */
async function replyText(replyToken, text) {
  if (!LINE_TOKEN) { console.warn("[replyText] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: String(text || "").slice(0, 4900) }]
    })
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
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    json.http = r.status;
    return json;
  } catch (e) {
    console.error("[postJSON]", e?.message || e);
    return { ok:false, error:e?.message || "fetch_failed" };
  } finally { clearTimeout(id); }
}

async function safeText(res) { try { return await res.text(); } catch { return ""; } }

/* ---------- 健康檢查 / 最小寫入 ---------- */
async function doHealthCheck() {
  const hasNotionKey = Boolean(NOTION_KEY);
  const hasMemberDB  = Boolean(MEMBER_DB);
  const hasRecordDB  = Boolean(RECORD_DB);
  let memQueryOk = false;
  if (hasNotionKey && hasMemberDB) {
    const r = await notionQueryDatabase(MEMBER_DB, { page_size: 1 });
    memQueryOk = !!(r && Array.isArray(r.results));
  }
  return {
    ok: hasNotionKey && hasMemberDB && hasRecordDB,
    hasNotionKey, hasMemberDB, hasRecordDB, memQueryOk,
    memberLineProp: LINE_PROP, memberEmailProp: EMAIL_PROP
  };
}

async function testMinimalWrite() {
  if (!RECORD_DB) return { ok:false, reason:"missing RECORD_DB_ID" };
  const nowTW = new Date().toLocaleString("zh-TW", { timeZone:"Asia/Taipei" });
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

/* ---------- 輔助 ---------- */
function helpText() {
  return [
    "可用指令：",
    "• 綁定 your@email.com  → 綁定 LINE 與會員",
    "• 我的狀態 / 狀態       → 查詢會員狀態/等級/有效日期",
    "• 簽到 [內容]           → 今日簽到（可附註）",
    "• 心得 你的心得……       → 紀錄學習/調理心得",
    "• 直接輸入症狀關鍵字     → 例如：肩頸痠痛、頭暈、胸悶、胃痛、腰痠",
  ].join("\n");
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  } catch { return iso; }
}
function shortId(id) { return id ? id.replace(/-/g,"").slice(0,8) : ""; }
