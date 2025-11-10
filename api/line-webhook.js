// /api/line-webhook.js  (Vercel / Node 18+, ESM)
import crypto from "crypto";
import OpenAI from "openai";

/* ========= 環境變數 ========= */
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const QA_DB_ID   = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || ""; // 教材 DB
const NOTION_VER = "2022-06-28";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_SECRET= process.env.LINE_CHANNEL_SECRET || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = "gpt-4o-mini";

/* ========= Notion：欄位名稱 ========= */
/* 會員 DB */
const MEMBER_EMAIL_PROP  = "Email";
const MEMBER_LINE_PROP   = "LINE UserId";
const MEMBER_STATUS_PROP = "狀態";       // Select
const MEMBER_LEVEL_PROP  = "等級";       // Select
const MEMBER_EXPIRE_PROP = "有效日期";   // Date

/* 教材 QA DB */
const QA_QUESTION = "問題";
const QA_TOPIC    = "主題";
const QA_SEGMENT  = "對應脊椎分節";
const QA_REPLY    = "教材版回覆";
const QA_FLOW     = "臨床流程建議";
const QA_MERIDIAN = "經絡與補充";

/* 記錄 DB */
const REC_TITLE = "標題";
const REC_EMAIL = "Email";
const REC_UID   = "UserId";
const REC_CATE  = "類別";   // Select
const REC_BODY  = "內容";   // Rich text
const REC_DATE  = "日期";   // Date
const REC_SRC   = "來源";   // ✅ Select（已改）
const REC_AI    = "AI回覆"; // Rich text
const REC_SEG   = "對應脊椎分節";

/* ========= 守門規則 ========= */
const BLOCK_STATUS_NAMES = ["停用", "封鎖", "黑名單", "禁用"];
const CHECK_EXPIRE = true;

/* ========= 小工具 ========= */
const trim = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const normalizeText = (s) => trim(String(s || "").replace(/\u3000/g, " ").replace(/\s+/g, " "));
const notFoundMessage = (q) => `找不到[${String(q || "").trim()}]的教材內容`;
const client = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* ========= 入口 ========= */
export default async function handler(req, res) {
  try {
    // 健康檢查
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        hint: "POST { text, userId } 或 LINE Webhook events。文案：以『文案 你的主題』觸發產文。"
      });
    }
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // LINE 驗簽（若未設定 Secret 則略過）
    if (LINE_SECRET && !verifyLineSignature(req, LINE_SECRET)) {
      return res.status(403).send("Invalid signature");
    }

    // 兼容：LINE Webhook & 直接 JSON 測試
    if (Array.isArray(req.body?.events)) {
      for (const ev of req.body.events) {
        try { await handleEvent(ev); } catch (e) { console.error("[event_error]", e); }
      }
      return res.status(200).json({ ok: true });
    } else {
      // 直接 JSON 測試
      const text = normalizeText(req.body?.text);
      const userId = req.body?.userId || "";
      if (!text) return res.status(400).json({ ok: false, error: "缺少 text" });
      const out = await handleText(text, userId, /*replyToken*/ null, /*source*/ "API");
      return res.status(200).json(out || { ok: true });
    }
  } catch (e) {
    console.error("[handler_crash]", e);
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
}

/* ========= 事件處理 ========= */
async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const text = normalizeText(ev.message.text);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";
  await handleText(text, userId, replyToken, "LINE");
}

async function handleText(text, userId, replyToken, source = "LINE") {
  // 指令：help
  if (/^(help|幫助|\?|指令)$/i.test(text)) {
    if (replyToken) await replyText(replyToken, helpText());
    return { ok: true, help: true };
  }

  // 指令：綁定 email
  if (/^綁定\s+/i.test(text) || isEmail(text)) {
    let email = text;
    if (/^綁定\s+/i.test(email)) email = normalizeText(email.replace(/^綁定\s+/i, ""));
    if (!isEmail(email)) {
      if (replyToken) await replyText(replyToken, "請輸入正確 Email，例如：綁定 test@example.com");
      return { ok: false, error: "invalid_email" };
    }
    const ok = await bindEmailToLine(userId, email);
    if (replyToken) {
      await replyText(replyToken, ok
        ? `✅ 已綁定 Email：${email}\n之後可直接輸入關鍵字查詢、簽到或寫心得。`
        : "綁定失敗：找不到此 Email 的會員，或該帳號已綁定其他 LINE。"
      );
    }
    return { ok };
  }

  // 指令：我的狀態
  if (/^(我的)?狀態$/i.test(text)) {
    const info = await getMemberInfoByLineId(userId);
    if (!info) {
      if (replyToken) await replyText(replyToken, "尚未綁定 Email。請輸入：綁定 your@email.com");
      return { ok: false, error: "not_binded" };
    }
    const expText = info.expire ? fmtDate(info.expire) : "（未設定）";
    const msg = `📇 會員狀態
Email：${info.email || "（未設定或空白）"}
狀態：${info.status || "（未設定）"}
等級：${info.level || "（未設定）"}
有效日期：${expText}
LINE 綁定：${info.lineBind || "（未設定）"}`;
    if (replyToken) await replyText(replyToken, msg);
    return { ok: true };
  }

  // 指令：簽到
  if (/^(簽到|打卡)(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) { if (replyToken) await replyText(replyToken, gate.hint); return { ok: false, error: "forbidden" }; }
    const content = normalizeText(text.replace(/^(簽到|打卡)(?:\s|$)/, "")) || "簽到";
    const pageId = await writeRecord({ email: gate.email, userId, category: "簽到", content, source });
    if (replyToken) await replyText(replyToken, `✅ 已簽到！\n內容：${content}\n(記錄ID: ${shortId(pageId)})`);
    return { ok: true };
  }

  // 指令：心得
  if (/^心得(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) { if (replyToken) await replyText(replyToken, gate.hint); return { ok: false, error: "forbidden" }; }
    const content = normalizeText(text.replace(/^心得(?:\s|$)/, ""));
    if (!content) {
      if (replyToken) await replyText(replyToken, "請在「心得」後面接文字，例如：心得 今天的頸胸交界手感更清楚了");
      return { ok: false, error: "empty_note" };
    }
    const pageId = await writeRecord({ email: gate.email, userId, category: "心得", content, source });
    if (replyToken) await replyText(replyToken, `📝 已寫入心得！\n${content}\n(記錄ID: ${shortId(pageId)})`);
    return { ok: true };
  }

  // 指令：顯示全部
  const mShowAll = /^顯示(全部|更多)(?:\s|$)(.+)$/i.exec(text);
  if (mShowAll) {
    const query = normalizeText(mShowAll[2] || "");
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) { if (replyToken) await replyText(replyToken, gate.hint); return { ok: false }; }

    // 主題：顯示全部 主題 XXX
    const mTopic = /^主題(?:\s|:|：)?\s*(.+)$/i.exec(query);
    if (mTopic) {
      const topic = normalizeText(mTopic[1]);
      const list = await queryQaByTopic(topic, 50);
      if (!list.length) { if (replyToken) await replyText(replyToken, notFoundMessage(topic)); return { ok: true, empty: true }; }
      const msg = formatSymptomsAll(`主題：${topic}`, list, 50);
      if (replyToken) await replyText(replyToken, msg);
      return { ok: true, count: list.length };
    }

    // 其它：走症狀 API
    const ans = await postJSON(ANSWER_URL, { q: query, question: query, email: gate.email }, 15000);
    const list = coerceList(ans);
    if (!list.length) { if (replyToken) await replyText(replyToken, notFoundMessage(query)); return { ok: true, empty: true }; }
    const msgAll = formatSymptomsAll(query, list, 50);
    if (replyToken) await replyText(replyToken, msgAll);
    return { ok: true, count: list.length };
  }

  // 指令：主題 XXX（或直接把整句當主題找）
  const mTopic = /^主題(?:\s|:|：)?\s*(.+)$/i.exec(text);
  if (mTopic) {
    const topic = normalizeText(mTopic[1]);
    return await doTopicSearch(replyToken, userId, topic, source);
  }
  if (QA_DB_ID) {
    const itemsAsTopic = await queryQaByTopic(text, 10);
    if (itemsAsTopic.length > 0) {
      return await doTopicSearch(replyToken, userId, text, source, itemsAsTopic);
    }
  }

  // 指令：文案 XXX（AI 產文）
  const mCopy = /^文案[\s：:](.+)$/.exec(text);
  if (mCopy) {
    const topic = normalizeText(mCopy[1]);
    return await doAICopy(replyToken, userId, topic, source);
  }

  // 其它 → 症狀關鍵字查詢（ANSWER_URL）
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) { if (replyToken) await replyText(replyToken, gate.hint); return { ok: false }; }

  const recId = await writeRecord({ email: gate.email, userId, category: "症狀查詢", content: text, source });
  const ans = await postJSON(ANSWER_URL, { q: text, question: text, email: gate.email }, 15000);
  const list = coerceList(ans);

  if (!list.length) {
    if (replyToken) await replyText(replyToken, notFoundMessage(text));
    return { ok: true, empty: true };
  }

  // 回填第一筆摘要與分節
  const first = list[0] || ans?.answer || {};
  const segFirst = getField(first, ["對應脊椎分節", "segments", "segment"]) || "";
  const tipFirst = getField(first, ["教材版回覆", "教材重點", "tips", "summary", "reply"]) || "";
  await patchRecordById(recId, { seg: segFirst, tip: tipFirst });

  // 產 Flex
  const flex = itemsToFlexCarousel(list, `查詢：${text}`);
  const okFlex = replyToken ? await replyFlex(replyToken, flex) : false;
  if (!okFlex && replyToken) {
    const out = formatSymptomsMessage(text, list, 3);
    if (out.moreCount > 0) {
      await replyTextQR(replyToken, out.text, [{ label: "顯示全部", text: `顯示全部 ${text}` }]);
    } else {
      await replyText(replyToken, out.text);
    }
  }
  return { ok: true, count: list.length };
}

/* ========= 主題查詢 ========= */
async function doTopicSearch(replyToken, userId, topicRaw, source, itemsOptional) {
  const topic = normalizeText(topicRaw);
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) { if (replyToken) await replyText(replyToken, gate.hint); return { ok: false }; }

  const recId = await writeRecord({ email: gate.email, userId, category: "症狀查詢", content: `主題 ${topic}`, source });
  const items = Array.isArray(itemsOptional) ? itemsOptional : await queryQaByTopic(topic, 10);

  if (!items.length) {
    if (replyToken) await replyText(replyToken, notFoundMessage(topic));
    return { ok: true, empty: true };
  }

  // 回填第一筆
  const first = items[0] || {};
  const segFirst = getField(first, ["對應脊椎分節"]) || "";
  const tipFirst = getField(first, ["教材版回覆", "教材重點"]) || "";
  await patchRecordById(recId, { seg: segFirst, tip: tipFirst });

  const flex = itemsToFlexCarousel(items, `主題：${topic}`);
  const okFlex = replyToken ? await replyFlex(replyToken, flex) : false;
  if (!okFlex && replyToken) {
    const out = formatSymptomsMessage(`主題：${topic}`, items, 4);
    if (out.moreCount > 0) {
      await replyTextQR(replyToken, out.text, [{ label: "顯示全部", text: `顯示全部 主題 ${topic}` }]);
    } else {
      await replyText(replyToken, out.text);
    }
  }
  return { ok: true, count: items.length };
}

/* ========= AI 產文 ========= */
function buildMarketingMessages(userText) {
  return [
    {
      role: "system",
      content:
        "你是一位溫柔、療癒、可信任的台灣在地行銷文案助手。請以 50–80 字撰寫貼文開頭，避免醫療/療效承諾字眼，最後加 2–4 個 hashtag（繁體）。",
    },
    { role: "user", content: userText },
  ];
}

async function doAICopy(replyToken, userId, topic, source) {
  if (!client) {
    if (replyToken) await replyText(replyToken, "系統未設定 OPENAI_API_KEY，無法產生文案。");
    return { ok: false, error: "no_openai_key" };
  }
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) { if (replyToken) await replyText(replyToken, gate.hint); return { ok: false }; }

  const started = Date.now();
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: buildMarketingMessages(topic),
    temperature: 0.7,
  });
  const latency = Date.now() - started;
  const text = completion.choices?.[0]?.message?.content?.trim() || "";

  await writeRecord({
    email: gate.email,
    userId,
    category: "AI產文",
    content: topic,
    source, // ✅ 記錄來源為 Select
  });
  // 另外寫一筆只更新 AI回覆？— 直接在上面新增時就寫入 AI回覆也行
  // 為單純起見，改為：新增同一筆時就塞 AI回覆
  // → 重寫 writeRecord 支援 aiText（向下相容）
  return await writeRecord({ email: gate.email, userId, category: "AI產文", content: topic, source, aiText: text })
    .then(async (pid) => {
      if (replyToken) await replyText(replyToken, text);
      return { ok: true, answer: text, latency_ms: latency, id: pid };
    })
    .catch(async (e) => {
      console.error("[AICopy writeRecord]", e?.message || e);
      if (replyToken) await replyText(replyToken, text); // 仍回文字，避免體感失敗
      return { ok: true, answer: text, warn: "notion_write_failed" };
    });
}

/* ========= QA_DB 查詢 ========= */
async function queryQaByTopic(topic, limit = 10) {
  if (!QA_DB_ID || !topic) return [];
  const r = await notionQueryDatabase(QA_DB_ID, {
    filter: { property: QA_TOPIC, select: { equals: topic } },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: limit,
  });
  const pages = Array.isArray(r?.results) ? r.results : [];
  return pages.map(pageToItem);
}

function pageToItem(page) {
  const p = page?.properties || {};
  const tText = (prop) => (prop?.title || []).map(t => t?.plain_text || "").join("").trim();
  const rText = (prop) => (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  return {
    問題: tText(p[QA_QUESTION]) || rText(p[QA_QUESTION]) || "",
    主題:  p[QA_TOPIC]?.select?.name || "",
    對應脊椎分節: rText(p[QA_SEGMENT]) || "",
    教材版回覆: rText(p[QA_REPLY]) || "",
    教材重點: rText(p[QA_REPLY]) || "", // 相容鍵名
    臨床流程建議: rText(p[QA_FLOW]) || "",
    經絡與補充: rText(p[QA_MERIDIAN]) || "",
  };
}

/* ========= 記錄 DB：寫入 / 更新 ========= */
async function writeRecord({ email, userId, category, content, source, aiText }) {
  const nowISO = new Date().toISOString();
  const nowTW  = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const props = {
    [REC_TITLE]: { title: [{ text: { content: `${category}｜${nowTW}` } }] },
    [REC_EMAIL]: email ? { email } : undefined,                   // Email 型別
    [REC_UID]:   { rich_text: [{ text: { content: userId || "" } }] },
    [REC_CATE]:  { select: { name: category || "記錄" } },        // Select
    [REC_BODY]:  { rich_text: [{ text: { content: content || "" } }] },
    [REC_DATE]:  { date: { start: nowISO } },
    [REC_SRC]:   { select: { name: source || "LINE" } },          // ✅ Select
    [REC_AI]:    aiText ? { rich_text: [{ text: { content: aiText } }] } : undefined,
  };

  const r = await notionCreatePage(RECORD_DB, props);
  if (!r.ok) throw new Error("notion_create_failed");
  return r.json?.id || "";
}

async function patchRecordById(pageId, { seg, tip }) {
  if (!pageId) return;
  const page = await notionGetPage(pageId);
  const propsNow = page?.properties || {};
  const outProps = {};
  if (typeof seg !== "undefined" && propsNow[REC_SEG]) outProps[REC_SEG] = buildPropValueByType(propsNow[REC_SEG], seg ?? "");
  if (typeof tip !== "undefined" && propsNow[REC_AI])  outProps[REC_AI]  = buildPropValueByType(propsNow[REC_AI],  tip ?? "");
  const keys = Object.keys(outProps);
  if (!keys.length) return;
  const ok = await notionPatchPage(pageId, { properties: outProps });
  if (!ok) console.error("[patchRecordById] failed", outProps);
}

/* ========= 會員守門 ========= */
async function ensureMemberAllowed(userId) {
  const info = await getMemberInfoByLineId(userId);
  if (!info || !isEmail(info.email)) {
    return { ok: false, email: "", hint: "尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com" };
  }
  const statusName = String(info.status || "").trim();
  if (statusName && BLOCK_STATUS_NAMES.includes(statusName)) {
    return { ok: false, email: info.email, hint: `此帳號狀態為「${statusName}」，暫停使用查詢/簽到/心得功能。` };
  }
  if (CHECK_EXPIRE && info.expire) {
    const expDate = new Date(info.expire);
    const today = new Date(new Date().toDateString());
    if (String(expDate) !== "Invalid Date" && expDate < today) {
      return { ok: false, email: info.email, hint: `此帳號已過有效日期（${fmtDate(info.expire)}）。` };
    }
  }
  return { ok: true, email: info.email, status: info.status, expire: info.expire };
}

async function getMemberInfoByLineId(userId) {
  if (!MEMBER_DB || !userId) return null;
  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_LINE_PROP, rich_text: { equals: userId } }, page_size: 1
  });
  if (!r?.results?.length) return null;
  const p = r.results[0]?.properties || {};
  const email  = readPropEmail(p, MEMBER_EMAIL_PROP);
  const status = p[MEMBER_STATUS_PROP]?.select?.name || "";
  const level  = p[MEMBER_LEVEL_PROP]?.select?.name || "";
  const expire = p[MEMBER_EXPIRE_PROP]?.date?.start || "";
  const lineBind = (p[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  return { email, status, level, expire, lineBind };
}

async function bindEmailToLine(userId, email) {
  if (!MEMBER_DB || !userId || !isEmail(email)) return false;
  let r = await notionQueryDatabase(MEMBER_DB, { filter: { property: MEMBER_EMAIL_PROP, email: { equals: email } }, page_size: 1 });
  if (!r?.results?.length) r = await notionQueryDatabase(MEMBER_DB, { filter: { property: MEMBER_EMAIL_PROP, rich_text: { equals: email } }, page_size: 1 });
  if (!r?.results?.length) r = await notionQueryDatabase(MEMBER_DB, { filter: { property: MEMBER_EMAIL_PROP, title: { equals: email } }, page_size: 1 });
  if (!r?.results?.length) return false;

  const page = r.results[0];
  const pageId = page.id;
  const props  = page.properties || {};
  const existing = (props[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (existing) return existing === userId;

  return await notionPatchPage(pageId, { properties: { [MEMBER_LINE_PROP]: { rich_text: [{ text: { content: userId } }] } } });
}

/* ========= Notion HTTP ========= */
async function notionQueryDatabase(dbId, body) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  try { return await r.json(); } catch { return {}; }
}

async function notionPatchPage(pageId, data) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data || {}),
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
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error("[notionCreatePage]", r.status, j);
  return { ok: r.ok, json: j, status: r.status };
}

async function notionGetPage(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json",
    },
  });
  try { return await r.json(); } catch { return {}; }
}

/* ========= 文字處理 / Flex ========= */
function coerceList(ans) {
  if (Array.isArray(ans?.results)) return ans.results;
  if (Array.isArray(ans?.items))   return ans.items;
  return ans?.answer ? [ans.answer] : [];
}

function getField(obj, keys) { if (!obj) return ""; for (const k of keys) if (obj[k]) return String(obj[k]); return ""; }

function formatSymptomsMessage(query, items, showN = 3) {
  const arr = items || [];
  const shown = arr.slice(0, showN);
  const moreCount = Math.max(0, arr.length - shown.length);

  if (!shown.length) return { text: notFoundMessage(query), moreCount: 0 };

  const lines = [`🔎 查詢：「${query}」`];
  shown.forEach((it, idx) => {
    const q    = getField(it, ["question","問題","query"]) || query;
    const key1 = getField(it, ["教材版回覆","教材重點","臨床流程建議","tips","summary","reply"]) || "—";
    const seg  = getField(it, ["對應脊椎分節","segments","segment"]) || "—";
    const flow = getField(it, ["臨床流程建議","flow","process"]) || "—";
    const mer  = getField(it, ["經絡與補充","meridians","meridian","經絡","經絡強補充"]) || "—";
    const ai   = getField(it, ["AI回覆","ai_reply","ai","answer"]) || "—";
    lines.push(
      `${idx===0 ? "\n" : ""}#${idx+1} 症狀對應`,
      `・問題：${q}`,
      `・教材重點：${key1}`,
      `・對應脊椎分節：${seg}`,
      `・臨床流程建議：${flow}`,
      `・經絡與補充：${mer}`,
      `・AI回覆：${ai}`,
      ""
    );
  });

  if (moreCount > 0) lines.push("", `（還有 ${moreCount} 筆。你可輸入「顯示全部 …」查看全部。）`);
  return { text: lines.join("\n"), moreCount };
}

function formatSymptomsAll(query, items, limit = 50) {
  const arr = (items || []).slice(0, limit);
  if (!arr.length) return notFoundMessage(query);

  const lines = [`🔎 查詢：「${query}」`];
  arr.forEach((it, idx) => {
    const q    = getField(it, ["question","問題","query"]) || query;
    const key1 = getField(it, ["教材版回覆","教材重點","臨床流程建議","tips","summary","reply"]) || "—";
    const seg  = getField(it, ["對應脊椎分節","segments","segment"]) || "—";
    const flow = getField(it, ["臨床流程建議","flow","process"]) || "—";
    const mer  = getField(it, ["經絡與補充","meridians","meridian","經絡","經絡強補充"]) || "—";
    const ai   = getField(it, ["AI回覆","ai_reply","ai","answer"]) || "—";
    lines.push(
      `${idx===0 ? "\n" : ""}#${idx+1} 症狀對應`,
      `・問題：${q}`,
      `・教材重點：${key1}`,
      `・對應脊椎分節：${seg}`,
      `・臨床流程建議：${flow}`,
      `・經絡與補充：${mer}`,
      `・AI回覆：${ai}`,
      ""
    );
  });
  return lines.join("\n");
}

function buildTableRow(label, value) {
  return {
    type: "box", layout: "baseline", spacing: "sm",
    contents: [
      { type: "text", text: String(label), size: "sm", weight: "bold", flex: 3, wrap: true },
      { type: "text", text: String(value || "—"), size: "sm", flex: 9, wrap: true }
    ]
  };
}

function itemToFlexBubble(item, title) {
  const q    = getField(item, ["question","問題","query"]) || "—";
  const key1 = getField(item, ["教材版回覆","教材重點","臨床流程建議","tips","summary","reply"]) || "—";
  const seg  = getField(item, ["對應脊椎分節","segments","segment"]) || "—";
  const flow = getField(item, ["臨床流程建議","flow","process"]) || "—";
  const mer  = getField(item, ["經絡與補充","meridians","meridian","經絡","經絡強補充"]) || "—";
  const ai   = getField(item, ["AI回覆","ai_reply","ai","answer"]) || "—";

  return {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: String(title).slice(0, 36), weight: "bold", size: "md" }] },
    body: {
      type: "box", layout: "vertical", spacing: "sm",
      contents: [
        buildTableRow("問題", q),
        buildTableRow("教材重點", key1),
        buildTableRow("對應脊椎分節", seg),
        buildTableRow("臨床流程建議", flow),
        buildTableRow("經絡與補充", mer),
        buildTableRow("AI回覆", ai),
      ]
    }
  };
}

function itemsToFlexCarousel(items, titlePrefix = "查詢") {
  const arr = (items || []).slice(0, 10);
  const bubbles = arr.map((it, idx) => itemToFlexBubble(it, `${titlePrefix} #${idx + 1}`));
  if (bubbles.length === 1) return bubbles[0];
  return { type: "carousel", contents: bubbles };
}

/* ========= HTTP / 其他 ========= */
function verifyLineSignature(req, secret) {
  const sig = req.headers["x-line-signature"];
  if (!sig) return false;
  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === sig;
}

async function postJSON(url, body, timeoutMs = 15000) {
  const ac = new AbortController(); const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    json.http = r.status;
    return json;
  } catch (e) {
    console.error("[postJSON]", e?.message || e);
    return { ok: false, error: e?.message || "fetch_failed" };
  } finally { clearTimeout(id); }
}

async function safeText(res) { try { return await res.text(); } catch { return ""; } }

function readPropEmail(props, key) {
  if (!props || !key || !props[key]) return "";
  const e1 = props[key]?.email || ""; if (e1 && isEmail(e1)) return e1.trim();
  const e2 = (props[key]?.rich_text || []).map(t => t?.plain_text || "").join("").trim(); if (e2 && isEmail(e2)) return e2;
  const e3 = (props[key]?.title || []).map(t => t?.plain_text || "").join("").trim(); if (e3 && isEmail(e3)) return e3;
  return "";
}

/* ========= LINE 回覆 ========= */
async function replyText(replyToken, text) {
  if (!LINE_TOKEN) { console.warn("[replyText] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text || "").slice(0, 4900) }] })
  });
  if (!r.ok) console.error("[replyText]", r.status, await safeText(r));
}

async function replyTextQR(replyToken, text, quickList = []) {
  if (!LINE_TOKEN) { console.warn("[replyTextQR] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const items = (quickList || []).map(q => ({ type: "action", action: { type: "message", label: q.label, text: q.text } })).slice(0, 12);
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text || "").slice(0, 4900), quickReply: items.length ? { items } : undefined }] })
  });
  if (!r.ok) console.error("[replyTextQR]", r.status, await safeText(r));
}

/* ========= 說明 ========= */
function helpText() {
  return [
    "可用指令：",
    "• 綁定 your@email.com",
    "• 狀態 / 我的狀態",
    "• 簽到 [內容]",
    "• 心得 你的心得……",
    "• 主題 基礎理論（或直接輸入：基礎理論）",
    "• 顯示全部 主題 基礎理論",
    "• 文案 你的主題（AI 產文）",
    "• 直接輸入症狀關鍵字（例：肩頸、頭暈、胸悶）"
  ].join("\n");
}

function fmtDate(iso) {
  try { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  catch { return iso; }
}
function shortId(id) { return id ? id.replace(/-/g, "").slice(0, 8) : ""; }
