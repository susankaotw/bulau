// api/line-webhook.js
// 功能：綁定 Email、查會員狀態、簽到、心得、主題查詢（Notion QA_DB）、症狀查詢（ANSWER_URL）
// 規則：顯示「教材重點」→ 一律取 Notion 欄位《教材版回覆》
// 守門：會員狀態=停用/封鎖/過期 → 禁用簽到/心得/查詢

/* ====== 環境變數 ====== */
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";
const QA_DB_ID   = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || ""; // 不老資料庫
const NOTION_VER = "2022-06-28";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

/* ====== 會員 DB 欄位 ====== */
const MEMBER_EMAIL_PROP  = "Email";
const MEMBER_LINE_PROP   = "LINE UserId";
const MEMBER_STATUS_PROP = "狀態";        // Select
const MEMBER_LEVEL_PROP  = "等級";        // Select
const MEMBER_EXPIRE_PROP = "有效日期";    // Date

/* 守門名單（可依你的 DB 字樣調整） */
const BLOCK_STATUS_NAMES = ["停用", "封鎖", "黑名單", "禁用"];
const CHECK_EXPIRE = true;

/* ====== QA DB 欄位 ====== */
const QA_QUESTION = "問題";
const QA_TOPIC    = "主題";
const QA_SEGMENT  = "對應脊椎分節";
const QA_REPLY    = "教材版回覆";     // <<— 教材重點來源
const QA_FLOW     = "臨床流程建議";
const QA_MERIDIAN = "經絡與補充";

/* ====== 紀錄 DB 欄位 ====== */
const REC_TITLE = "標題";
const REC_EMAIL = "Email";
const REC_UID   = "UserId";
const REC_CATE  = "類別";
const REC_BODY  = "內容";
const REC_DATE  = "日期";
const REC_SRC   = "來源";
const REC_AI    = "AI回覆";
const REC_SEG   = "對應脊椎分節";

/* ====== 小工具 ====== */
const trim = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const normalizeText = (s) => trim(String(s || "").replace(/\u3000/g," ").replace(/\s+/g," "));

/* ====== 入口 ====== */
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") return res.status(200).send("OK");
    if (req.method !== "POST") return res.status(405).end();
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) { try { await handleEvent(ev); } catch (e) { console.error("[event_error]", e); } }
    res.status(200).json({ ok:true });
  } catch (e) {
    console.error("[handler_crash]", e);
    res.status(200).json({ ok:false, error:e?.message || "unknown_error" });
  }
};

/* ====== 主流程 ====== */
async function handleEvent(ev){
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const text = normalizeText(ev.message.text);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

  // Quick Reply：「顯示全部 主題 XXX」/「顯示全部 XXX(症狀)」
  const mShowAll = /^顯示(全部|更多)(?:\s|$)(.+)$/i.exec(text);
  if (mShowAll) {
    const query = normalizeText(mShowAll[2] || "");
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) { await replyText(replyToken, gate.hint); return; }

    // 「顯示全部 主題 基礎理論」→ 主題查詢
    const mTopic = /^主題(?:\s|:|：)?\s*(.+)$/i.exec(query);
    if (mTopic) {
      const topic = normalizeText(mTopic[1]);
      const list = await queryQaByTopic(topic, 50);

      // Flex 版本（最多 12 張卡）
      try {
        const flex = buildSymptomsCarousel(`主題：${topic}`, list, Math.min(12, (list||[]).length || 1));
        await replyFlex(replyToken, `主題：${topic}（全部）`, flex);
      } catch (e) {
        console.error("[showall_topic_flex_fallback]", e);
        const msg = formatSymptomsAll(`主題：${topic}`, list, 50);
        await replyText(replyToken, msg);
      }
      return;
    }

    // 其餘 → 症狀（ANSWER_URL）
    const ans  = await postJSON(ANSWER_URL, { q: query, question: query, email: gate.email }, 15000);
    const list = coerceList(ans);
    try {
      const flex = buildSymptomsCarousel(query, list, Math.min(12, (list||[]).length || 1));
      await replyFlex(replyToken, `查詢：「${query}」（全部）`, flex);
    } catch (e) {
      console.error("[showall_symptom_flex_fallback]", e);
      const msgAll = formatSymptomsAll(query, list, 50);
      await replyText(replyToken, msgAll);
    }
    return;
  }

  // help
  if (/^(help|幫助|\?|指令)$/i.test(text)) { await replyText(replyToken, helpText()); return; }

  // 綁定
  if (/^綁定\s+/i.test(text) || isEmail(text)) {
    let email = text;
    if (/^綁定\s+/i.test(email)) email = normalizeText(email.replace(/^綁定\s+/i, ""));
    if (!isEmail(email)) { await replyText(replyToken, "請輸入正確 Email，例如：綁定 test@example.com"); return; }
    const ok = await bindEmailToLine(userId, email);
    await replyText(replyToken, ok
      ? `✅ 已綁定 Email：${email}\n之後可直接輸入關鍵字查詢、簽到或寫心得。`
      : "綁定失敗：找不到此 Email 的會員，或該帳號已綁定其他 LINE。"
    );
    return;
  }

  // 狀態
  if (/^(我的)?狀態$/i.test(text)) {
    const info = await getMemberInfoByLineId(userId);
    if (!info) { await replyText(replyToken, "尚未綁定 Email。請輸入：綁定 your@email.com"); return; }
    const expText = info.expire ? fmtDate(info.expire) : "（未設定）";
    await replyText(replyToken,
      `📇 會員狀態\nEmail：${info.email || "（未設定或空白）"}\n狀態：${info.status || "（未設定）"}\n等級：${info.level || "（未設定）"}\n有效日期：${expText}\nLINE 綁定：${info.lineBind || "（未設定）"}`
    );
    return;
  }

  // 簽到
  if (/^(簽到|打卡)(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) { await replyText(replyToken, gate.hint); return; }
    const content = normalizeText(text.replace(/^(簽到|打卡)(?:\s|$)/, "")) || "簽到";
    const pageId = await writeRecord({ email: gate.email, userId, category:"簽到", content });
    await replyText(replyToken, `✅ 已簽到！\n內容：${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  // 心得
  if (/^心得(?:\s|$)/.test(text)) {
    const gate = await ensureMemberAllowed(userId);
    if (!gate.ok) { await replyText(replyToken, gate.hint); return; }
    const content = normalizeText(text.replace(/^心得(?:\s|$)/, ""));
    if (!content) { await replyText(replyToken, "請在「心得」後面接文字，例如：心得 今天的頸胸交界手感更清楚了"); return; }
    const pageId = await writeRecord({ email: gate.email, userId, category:"心得", content });
    await replyText(replyToken, `📝 已寫入心得！\n${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  // ===== 主題查詢 =====
  // 1) 明確指令：主題 XXX
  const mTopic = /^主題(?:\s|:|：)?\s*(.+)$/i.exec(text);
  if (mTopic) {
    const topic = normalizeText(mTopic[1]);
    await doTopicSearch(replyToken, userId, topic);
    return;
  }
  // 2) 直接輸入一個字串 → 先當「主題」查（Select equals），若有結果就用主題模式
  if (QA_DB_ID) {
    const itemsAsTopic = await queryQaByTopic(text, 10);
    if (itemsAsTopic.length > 0) {
      await doTopicSearch(replyToken, userId, text, itemsAsTopic);
      return;
    }
  }

  // ===== 其餘 → 症狀關鍵字查詢（ANSWER_URL）=====
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) { await replyText(replyToken, gate.hint); return; }

  const pageId = await writeRecord({ email: gate.email, userId, category:"症狀查詢", content:text });
  const ans  = await postJSON(ANSWER_URL, { q:text, question:text, email: gate.email }, 15000);
  const list = coerceList(ans);

  const first    = list[0] || ans?.answer || {};
  const segFirst = getField(first, ["對應脊椎分節","segments","segment"]) || "";
  // 教材重點一律優先《教材版回覆》
  const tipFirst = getField(first, ["教材版回覆","教材重點","tips","summary","reply"]) || "";
  await patchRecordById(pageId, { seg: segFirst, tip: tipFirst });

  // 優先用 Flex；失敗降級文字
  try {
    const flex = buildSymptomsCarousel(text, list, 3);
    const moreBtn = coerceList(list).length > 3 ? [{ label:"顯示全部", text:`顯示全部 ${text}` }] : [];
    await replyFlex(replyToken, `查詢：「${text}」`, flex, moreBtn);
  } catch (e) {
    console.error("[symptom_flex_fallback]", e);
    const out = formatSymptomsMessage(text, list, 3);
    if (out.moreCount > 0) {
      await replyTextQR(replyToken, out.text, [{ label:"顯示全部", text:`顯示全部 ${text}` }]);
    } else {
      await replyText(replyToken, out.text);
    }
  }
}

/* ====== 主題查詢子流程 ====== */
async function doTopicSearch(replyToken, userId, topicRaw, itemsOptional) {
  const topic = normalizeText(topicRaw);
  const gate = await ensureMemberAllowed(userId);
  if (!gate.ok) { await replyText(replyToken, gate.hint); return; }

  const pageId = await writeRecord({ email: gate.email, userId, category:"症狀查詢", content:`主題 ${topic}` });

  const items = Array.isArray(itemsOptional) ? itemsOptional : await queryQaByTopic(topic, 10);

  // 取第一筆做回填
  const first    = items[0] || {};
  const segFirst = getField(first, ["對應脊椎分節"]) || "";
  const tipFirst = getField(first, ["教材版回覆","教材重點"]) || "";
  await patchRecordById(pageId, { seg: segFirst, tip: tipFirst });

  // 優先 Flex；失敗降級文字
  try {
    const flex = buildSymptomsCarousel(`主題：${topic}`, items, 4);
    const moreBtn = (items||[]).length > 4 ? [{ label:"顯示全部", text:`顯示全部 主題 ${topic}` }] : [];
    await replyFlex(replyToken, `主題：${topic}`, flex, moreBtn);
  } catch (e) {
    console.error("[topic_flex_fallback]", e);
    const out = formatSymptomsMessage(`主題：${topic}`, items, 4);
    if (out.moreCount > 0) {
      await replyTextQR(replyToken, out.text, [{ label:"顯示全部", text:`顯示全部 主題 ${topic}` }]);
    } else {
      await replyText(replyToken, out.text);
    }
  }
}

/* ====== QA_DB 查詢 ====== */
async function queryQaByTopic(topic, limit=10){
  if (!QA_DB_ID || !topic) return [];
  const r = await notionQueryDatabase(QA_DB_ID, {
    filter: { property: QA_TOPIC, select: { equals: topic } },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: limit
  });
  const pages = Array.isArray(r?.results) ? r.results : [];
  return pages.map(pageToItem);
}

function pageToItem(page){
  const p = page?.properties || {};
  const tText = (prop) => (prop?.title || []).map(t => t?.plain_text || "").join("").trim();
  const rText = (prop) => (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  return {
    問題: tText(p[QA_QUESTION]) || rText(p[QA_QUESTION]) || "",
    主題:  p[QA_TOPIC]?.select?.name || "",
    對應脊椎分節: rText(p[QA_SEGMENT]) || "",
    教材版回覆: rText(p[QA_REPLY]) || "",
    教材重點: rText(p[QA_REPLY]) || "",   // 相容鍵名（同等於教材版回覆）
    臨床流程建議: rText(p[QA_FLOW]) || "",
    經絡與補充: rText(p[QA_MERIDIAN]) || "",
  };
}

/* ====== 症狀回覆格式（純文字備援） ====== */
function coerceList(ans) {
  if (Array.isArray(ans?.results)) return ans.results;
  if (Array.isArray(ans?.items))   return ans.items;
  return ans?.answer ? [ans.answer] : [];
}

function formatSymptomsMessage(query, items, showN=3){
  const arr = items || [];
  const shown = arr.slice(0, showN);
  const moreCount = Math.max(0, arr.length - shown.length);
  const lines = [`🔎 查詢：「${query}」`];

  if (!shown.length){
    lines.push(
      "", "#1 症狀對應",
      "・問題：—",
      "・教材重點：—",
      "・對應脊椎分節：—",
      "・臨床流程建議：—",
      "・經絡與補充：—",
      "・AI回覆：—",
      ""
    );
  } else {
    shown.forEach((it, idx) => {
      const q    = getField(it, ["question","問題","query"]) || query;
      const key1 = getField(it, ["教材版回覆","教材重點","tips","summary","reply"]) || "—";
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
  }

  if (moreCount > 0) lines.push("", `（還有 ${moreCount} 筆。你可輸入「顯示全部 …」查看全部。）`);
  return { text: lines.join("\n"), moreCount };
}

function formatSymptomsAll(query, items, limit=50){
  const arr = (items || []).slice(0, limit);
  const lines = [`🔎 查詢：「${query}」`];

  if (!arr.length){
    lines.push(
      "", "#1 症狀對應",
      "・問題：—",
      "・教材重點：—",
      "・對應脊椎分節：—",
      "・臨床流程建議：—",
      "・經絡與補充：—",
      "・AI回覆：—",
      ""
    );
  } else {
    arr.forEach((it, idx) => {
      const q    = getField(it, ["question","問題","query"]) || query;
      const key1 = getField(it, ["教材版回覆","教材重點","tips","summary","reply"]) || "—";
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
  }
  return lines.join("\n");
}

function getField(obj, keys){ if (!obj) return ""; for (const k of keys) if (obj[k]) return String(obj[k]); return ""; }

/* ====== 會員狀態守門 ====== */
async function ensureMemberAllowed(userId){
  const info = await getMemberInfoByLineId(userId);
  if (!info || !isEmail(info.email)) {
    return { ok:false, email:"", hint:"尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com" };
  }
  const statusName = String(info.status || "").trim();
  if (statusName && BLOCK_STATUS_NAMES.includes(statusName)) {
    return { ok:false, email:info.email, hint:`此帳號狀態為「${statusName}」，暫停使用查詢/簽到/心得功能。` };
  }
  if (CHECK_EXPIRE && info.expire) {
    const expDate = new Date(info.expire);
    const today = new Date(new Date().toDateString());
    if (String(expDate) !== "Invalid Date" && expDate < today) {
      return { ok:false, email:info.email, hint:`此帳號已過有效日期（${fmtDate(info.expire)}）。` };
    }
  }
  return { ok:true, email:info.email, status:info.status, expire:info.expire };
}

async function getMemberInfoByLineId(userId){
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

async function bindEmailToLine(userId, email){
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

/* ====== Notion 共用 ====== */
async function notionQueryDatabase(dbId, body){
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  try { return await r.json(); } catch { return {}; }
}
async function notionPatchPage(pageId, data){
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" },
    body: JSON.stringify(data || {})
  });
  if (!r.ok) console.error("[notionPatchPage]", r.status, await safeText(r));
  return r.ok;
}
async function notionCreatePage(dbId, properties){
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" },
    body: JSON.stringify({ parent: { database_id: dbId }, properties })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error("[notionCreatePage]", r.status, j);
  return { ok: r.ok, json: j, status: r.status };
}

/* ====== 紀錄 DB 寫入／回填 ====== */
async function writeRecord({ email, userId, category, content }){
  const nowISO = new Date().toISOString();
  const nowTW  = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const props = {
    [REC_TITLE]: { title: [{ text: { content: `${category}｜${nowTW}` } }] },
    [REC_EMAIL]: { email },
    [REC_UID]:   { rich_text: [{ text: { content: userId } }] },
    [REC_CATE]:  { select: { name: category } },
    [REC_BODY]:  { rich_text: [{ text: { content } }] },
    [REC_DATE]:  { date: { start: nowISO } },
    [REC_SRC]:   { rich_text: [{ text: { content: "LINE" } }] }
  };
  const { ok, json } = await notionCreatePage(RECORD_DB, props);
  if (!ok) console.error("[writeRecord] create failed", json);
  return json?.id || "";
}

async function patchRecordById(pageId, { seg, tip }){
  if (!pageId) return;
  const page = await notionGetPage(pageId);
  const propsNow = page?.properties || {};
  const outProps = {};
  if (typeof seg !== "undefined" && propsNow[REC_SEG]) outProps[REC_SEG] = buildPropValueByType(propsNow[REC_SEG], seg ?? "");
  if (typeof tip !== "undefined" && propsNow[REC_AI])  outProps[REC_AI]  = buildPropValueByType(propsNow[REC_AI],  tip ?? "");
  const keys = Object.keys(outProps);
  if (!keys.length) { console.warn("[patchRecordById] no matched properties to update"); return; }
  const ok = await notionPatchPage(pageId, { properties: outProps });
  if (!ok) console.error("[patchRecordById] failed", outProps);
}

/* ====== Notion 輔助 ====== */
async function notionGetPage(pageId){
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" }
  });
  try { return await r.json(); } catch { return {}; }
}
function buildPropValueByType(propItem, value){
  const text = String(value ?? "").slice(0, 1900);
  if (!propItem || !propItem.type) return { rich_text: [{ text: { content: text } }] };
  switch (propItem.type) {
    case "title":        return { title: [{ text: { content: text } }] };
    case "rich_text":    return { rich_text: [{ text: { content: text } }] };
    case "select":       return { select: { name: (text.split(/[、,，\s]/).filter(Boolean)[0] || text || "—") } };
    case "multi_select": return { multi_select: text.split(/[、,，\s]/).filter(Boolean).slice(0,20).map(n => ({ name:n })) };
    default:             return { rich_text: [{ text: { content: text } }] };
  }
}

/* ====== Flex 卡片（症狀/主題通用） ====== */
// 將一筆結果轉成一張 bubble
function buildSymptomBubble(it, idx, queryLabel){
  const q    = getField(it, ["question","問題","query"]) || queryLabel || "查詢結果";
  const key1 = getField(it, ["教材版回覆","教材重點","tips","summary","reply"]) || "—";
  const seg  = getField(it, ["對應脊椎分節","segments","segment"]) || "—";
  const flow = getField(it, ["臨床流程建議","flow","process"]) || "—";
  const mer  = getField(it, ["經絡與補充","meridians","meridian","經絡","經絡強補充"]) || "—";
  const ai   = getField(it, ["AI回覆","ai_reply","ai","answer"]) || "—";

  const lim = (s, n=180) => String(s||"").length>n ? String(s).slice(0,n-1)+"…" : String(s||"");

  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        { type: "text", text: `#${idx+1} 症狀對應`, weight: "bold", size: "sm" },
        { type: "text", text: lim(q, 60), wrap: true, size: "md" }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "6px",
      contents: [
        { type: "box", layout: "baseline", spacing: "sm", contents: [
          { type: "text", text: "教材重點", color: "#888888", size: "sm", flex: 2 },
          { type: "text", text: lim(key1), wrap: true, size: "sm", flex: 5 }
        ]},
        { type: "box", layout: "baseline", spacing: "sm", contents: [
          { type: "text", text: "脊椎分節", color: "#888888", size: "sm", flex: 2 },
          { type: "text", text: lim(seg, 60), wrap: true, size: "sm", flex: 5 }
        ]},
        { type: "box", layout: "baseline", spacing: "sm", contents: [
          { type: "text", text: "臨床流程", color: "#888888", size: "sm", flex: 2 },
          { type: "text", text: lim(flow), wrap: true, size: "sm", flex: 5 }
        ]},
        { type: "box", layout: "baseline", spacing: "sm", contents: [
          { type: "text", text: "經絡補充", color: "#888888", size: "sm", flex: 2 },
          { type: "text", text: lim(mer), wrap: true, size: "sm", flex: 5 }
        ]},
        { type: "separator", margin: "md" },
        { type: "box", layout: "baseline", spacing: "sm", contents: [
          { type: "text", text: "AI回覆", color: "#888888", size: "sm", flex: 2 },
          { type: "text", text: lim(ai), wrap: true, size: "sm", flex: 5 }
        ]}
      ]
    }
  };
}

// 多筆資料 → carousel，最多 12 張（LINE 限制）
function buildSymptomsCarousel(queryLabel, items=[], showN=3){
  const arr = (items||[]).slice(0, Math.min(showN, 12));
  const bubbles = arr.map((it, i) => buildSymptomBubble(it, i, queryLabel));
  return { type: "carousel", contents: bubbles.length ? bubbles : [buildSymptomBubble({}, 0, queryLabel)] };
}

// 回覆 Flex（含 quick reply 選項）
async function replyFlex(replyToken, altText, flexContents, quickList=[]){
  if (!LINE_TOKEN) { console.warn("[replyFlex] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const items = (quickList||[]).map(q => ({ type:"action", action:{ type:"message", label:q.label, text:q.text }})).slice(0,12);
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: "flex",
        altText: String(altText||"查詢結果"),
        contents: flexContents,
        quickReply: items.length?{ items }:undefined
      }]
    })
  });
  if (!r.ok) console.error("[replyFlex]", r.status, await safeText(r));
}

/* ====== LINE 回覆（純文字/Quick Reply） ====== */
async function replyText(replyToken, text){
  if (!LINE_TOKEN) { console.warn("[replyText] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text||"").slice(0, 4900) }] })
  });
  if (!r.ok) console.error("[replyText]", r.status, await safeText(r));
}
async function replyTextQR(replyToken, text, quickList=[]){
  if (!LINE_TOKEN) { console.warn("[replyTextQR] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const items = (quickList||[]).map(q => ({ type:"action", action:{ type:"message", label:q.label, text:q.text }})).slice(0,12);
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type:"text", text:String(text||"").slice(0,4900), quickReply: items.length?{ items }:undefined }] })
  });
  if (!r.ok) console.error("[replyTextQR]", r.status, await safeText(r));
}

/* ====== HTTP / 其他 ====== */
async function postJSON(url, body, timeoutMs=15000){
  const ac = new AbortController(); const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", "Accept":"application/json" }, body:JSON.stringify(body||{}), signal:ac.signal });
    const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; } json.http = r.status; return json;
  } catch (e) { console.error("[postJSON]", e?.message || e); return { ok:false, error:e?.message || "fetch_failed" }; }
  finally { clearTimeout(id); }
}
async function safeText(res){ try { return await res.text(); } catch { return ""; } }
function readPropEmail(props, key){
  if (!props || !key || !props[key]) return "";
  const e1 = props[key]?.email || ""; if (e1 && isEmail(e1)) return e1.trim();
  const e2 = (props[key]?.rich_text || []).map(t => t?.plain_text || "").join("").trim(); if (e2 && isEmail(e2)) return e2;
  const e3 = (props[key]?.title || []).map(t => t?.plain_text || "").join("").trim(); if (e3 && isEmail(e3)) return e3;
  return "";
}

/* ====== 說明 ====== */
function helpText(){
  return [
    "可用指令：",
    "• 綁定 your@email.com",
    "• 狀態 / 我的狀態",
    "• 簽到 [內容]",
    "• 心得 你的心得……",
    "• 主題 基礎理論  （或直接輸入：基礎理論）",
    "• 顯示全部 主題 基礎理論",
    "• 直接輸入症狀關鍵字（例：肩頸、頭暈、胸悶）"
  ].join("\n");
}
function fmtDate(iso){ try{ const d=new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}catch{return iso;} }
function shortId(id){ return id ? id.replace(/-/g,"").slice(0,8) : ""; }
