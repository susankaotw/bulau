// api/line-webhook.js
// 功能：綁定 Email、查會員狀態、簽到、心得、症狀/主題查詢
// 修正：主題查詢強化 & 自測工具（GET: action=test-topic、LINE: debug 主題 xxx）

/* ====== 環境變數 ====== */
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const RECORD_DB  = process.env.RECORD_DB_ID || "";             // 紀錄 DB
const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";      // 會員 DB
const QA_DB_ID   = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || ""; // QA 主資料庫
const NOTION_VER = "2022-06-28";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

/* 會員 DB 欄位 */
const MEMBER_EMAIL_PROP = "Email";
const MEMBER_LINE_PROP  = "LINE UserId";

/* 紀錄 DB 欄位 */
const REC_TITLE  = "標題";
const REC_EMAIL  = "Email";
const REC_UID    = "UserId";
const REC_CATE   = "類別";
const REC_BODY   = "內容";
const REC_DATE   = "日期";
const REC_SRC    = "來源";
const REC_AI     = "AI回覆";
const REC_SEG    = "對應脊椎分節";

/* ====== 小工具 ====== */
const trim = (s) => String(s || "").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const normalizeText = (input) =>
  trim(String(input || "").replace(/\u3000/g, " ").replace(/\s+/g, " "));
const KNOWN_TOPICS = ["基礎理論","症狀對應","上肢","腰背","下肢"]; // 可自行擴充

/* ====== 入口 ====== */
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const action = String(req.query?.action || "");
      if (action === "health")     return res.status(200).json(await doHealthCheck());
      if (action === "test-write") return res.status(200).json(await testMinimalWrite());
      if (action === "test-topic") {
        const topic = normalizeText(req.query?.topic || "基礎理論");
        const items = await queryQaByTopic(topic, 5);
        return res.status(200).json({
          ok: true, topic, count: items.length,
          sample: items.map(x => ({ 問題: x.問題, 分節: x.對應脊椎分節, 教材: (x.教材版回覆 || x.教材重點).slice(0,50) }))
        });
      }
      return res.status(200).send("OK");
    }

    if (req.method !== "POST") return res.status(405).json({ ok:false, reason:"method_not_allowed" });

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) { try { await handleEvent(ev); } catch (e) { console.error("[event_error]", e); } }
    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error("[handler_crash]", e);
    return res.status(200).json({ ok:false, error:e?.message || "unknown_error" });
  }
};

/* ====== 主流程 ====== */
async function handleEvent(ev) {
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const raw = ev.message.text;
  const text = normalizeText(raw);
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";

  // debug 主題 xxx
  const mDebugTopic = /^debug\s*主題\s+(.+)$/i.exec(text);
  if (mDebugTopic) {
    const topic = normalizeText(mDebugTopic[1]);
    const items = await queryQaByTopic(topic, 5);
    const lines = [
      `🔧 debug 主題：「${topic}」`,
      `QA_DB 設定：${QA_DB_ID ? "✅" : "❌（未設定 NOTION_QA_DB_ID）"}`,
      `筆數：${items.length}`,
      ...(items.slice(0,3).map((x,i)=>`#${i+1} ${x.問題}｜${x.對應脊椎分節}｜${(x.教材版回覆 || x.教材重點 || "—").slice(0,30)}`))
    ];
    await replyText(replyToken, lines.join("\n"));
    return;
  }

  // Quick Reply：「顯示全部 xxx」
  const showAllMatch = text.match(/^顯示(全部|更多)(?:\s|$)(.+)/);
  if (showAllMatch) {
    const query = normalizeText(showAllMatch[2] || "");
    const ensured = await ensureEmailForUser(userId);
    if (!ensured.email) { await replyText(replyToken, ensured.hint); return; }

    // 顯示全部 主題 基礎理論
    const mTopic = query.match(/^主題(?:\s|:|：)?\s*(.+)$/);
    if (mTopic || isTopic(query)) {
      const topic = mTopic ? normalizeText(mTopic[1]) : query;
      const items = await queryQaByTopic(topic, 12);
      const out = formatSymptomsAll(`主題：${topic}`, items, 12);
      await replyText(replyToken, out);
      return;
    }

    const ans  = await postJSON(ANSWER_URL, { q: query, question: query, email: ensured.email }, 15000);
    const list = coerceList(ans);
    const msgAll = formatSymptomsAll(query, list, 12);
    await replyText(replyToken, msgAll);
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
    const { email, status, level, expire, lineBind } = info;
    const expText = expire ? fmtDate(expire) : "（未設定）";
    await replyText(replyToken,
      `📇 會員狀態\nEmail：${email || "（未設定或空白）"}\n狀態：${status || "（未設定）"}\n等級：${level || "（未設定）"}\n有效日期：${expText}\nLINE 綁定：${lineBind || "（未設定）"}`
    );
    return;
  }

  // 簽到
  if (/^(簽到|打卡)(?:\s|$)/.test(text)) {
    const ensured = await ensureEmailForUser(userId);
    if (!ensured.email) { await replyText(replyToken, ensured.hint); return; }
    const content = normalizeText(text.replace(/^(簽到|打卡)(?:\s|$)/, "")) || "簽到";
    const pageId = await writeRecord({ email: ensured.email, userId, category:"簽到", content });
    await replyText(replyToken, `✅ 已簽到！\n內容：${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  // 心得
  if (/^心得(?:\s|$)/.test(text)) {
    const ensured = await ensureEmailForUser(userId);
    if (!ensured.email) { await replyText(replyToken, ensured.hint); return; }
    const content = normalizeText(text.replace(/^心得(?:\s|$)/, ""));
    if (!content) { await replyText(replyToken, "請在「心得」後面接文字，例如：心得 今天的頸胸交界手感更清楚了"); return; }
    const pageId = await writeRecord({ email: ensured.email, userId, category:"心得", content });
    await replyText(replyToken, `📝 已寫入心得！\n${content}\n(記錄ID: ${shortId(pageId)})`);
    return;
  }

  // ===== 主題查詢（1) 主題 xxx 2) 直接輸入為已知主題） =====
  const mTopic = text.match(/^主題(?:\s|:|：)?\s*(.+)$/);
  if (mTopic || isTopic(text)) {
    const ensured = await ensureEmailForUser(userId);
    if (!ensured.email) { await replyText(replyToken, ensured.hint); return; }
    const topic = mTopic ? normalizeText(mTopic[1]) : text;

    const pageId = await writeRecord({ email: ensured.email, userId, category:"症狀查詢", content:`主題 ${topic}` });
    const items  = await queryQaByTopic(topic, 10);

    const first    = items[0] || {};
    const segFirst = getField(first, ["對應脊椎分節"]);
    const tipFirst = getField(first, ["教材版回覆","教材重點","臨床流程建議"]);
    await patchRecordById(pageId, { seg: segFirst, tip: tipFirst });

    const out = formatSymptomsMessage(`主題：${topic}`, items, 3);
    if (out.moreCount > 0) {
      await replyTextQR(replyToken, out.text, [{ label: "顯示全部", text: `顯示全部 主題 ${topic}` }]);
    } else {
      await replyText(replyToken, out.text);
    }
    return;
  }

  // ===== 其餘 → 症狀關鍵字查詢 =====
  const ensured = await ensureEmailForUser(userId);
  if (!ensured.email) { await replyText(replyToken, ensured.hint); return; }

  const category = "症狀查詢";
  const pageId = await writeRecord({ email: ensured.email, userId, category, content:text });

  const ans  = await postJSON(ANSWER_URL, { q:text, question:text, email: ensured.email }, 15000);
  const list = coerceList(ans);

  const first    = list[0] || ans?.answer || {};
  the
  const segFirst = getField(first, ["對應脊椎分節","segments","segment"]) || "";
  const tipFirst = getField(first, ["教材版回覆","教材重點","臨床流程建議","tips","summary","reply"]) || "";
  await patchRecordById(pageId, { seg: segFirst, tip: tipFirst });

  const out = formatSymptomsMessage(text, list, 3);
  if (out.moreCount > 0) {
    await replyTextQR(replyToken, out.text, [{ label: "顯示全部", text: `顯示全部 ${text}` }]);
  } else {
    await replyText(replyToken, out.text);
  }
}

/* ====== 主題查詢（直接查 Notion QA_DB） ====== */
function isTopic(s){ return KNOWN_TOPICS.includes(normalizeText(s)); }

async function queryQaByTopic(topic, limit = 10){
  if (!QA_DB_ID || !NOTION_KEY) return [];
  const body = {
    filter: { property: "主題", select: { equals: topic } },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: limit
  };
  const r = await notionQueryDatabase(QA_DB_ID, body);
  const pages = Array.isArray(r?.results) ? r.results : [];
  return pages.map(pageToItem);
}

function pageToItem(page){
  const p = page?.properties || {};
  const titleText = (prop) => (prop?.title || []).map(t => t?.plain_text || "").join("").trim();
  const rtText = (prop) => (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  return {
    問題: titleText(p["問題"]) || rtText(p["問題"]) || "",
    主題: p["主題"]?.select?.name || "",
    對應脊椎分節: rtText(p["對應脊椎分節"]) || "",
    教材版回覆: rtText(p["教材版回覆"]) || "",
    教材重點: rtText(p["教材重點"]) || "",
    臨床流程建議: rtText(p["臨床流程建議"]) || "",
    經絡與補充: rtText(p["經絡與補充"]) || "",
  };
}

/* ====== 症狀回覆格式 ====== */
function coerceList(ans) {
  if (Array.isArray(ans?.results)) return ans.results;
  if (Array.isArray(ans?.items))   return ans.items;
  return ans?.answer ? [ans.answer] : [];
}

function formatSymptomsMessage(query, items, showN = 3) {
  const arr = items || [];
  const shown = arr.slice(0, showN);
  const moreCount = Math.max(0, arr.length - shown.length);

  const lines = [`🔎 查詢：「${query}」`];
  if (!shown.length) {
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
      const q    = getField(it, ["question", "問題", "query"]) || query;
      const key1 = getField(it, ["教材版回覆","教材重點","臨床流程建議","tips","summary","reply"]) || "—";
      const seg  = getField(it, ["對應脊椎分節","segments","segment"]) || "—";
      const flow = getField(it, ["臨床流程建議","flow","process"]) || "—";
      const mer  = getField(it, ["經絡與補充","meridians","meridian","經絡","經絡強補充"]) || "—";
      const ai   = getField(it, ["AI回覆","ai_reply","ai","answer"]) || "—";
      lines.push(
        `${idx === 0 ? "\n" : ""}#${idx+1} 症狀對應`,
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

  if (moreCount > 0) {
    lines.push("", `（還有 ${moreCount} 筆。建議重新查詢縮小範圍；或點下方「顯示全部」查看全部。）`);
  }
  return { text: lines.join("\n"), moreCount };
}

function formatSymptomsAll(query, items, limit = 12) {
  const arr = (items || []).slice(0, limit);
  const lines = [`🔎 查詢：「${query}」`];
  if (!arr.length) {
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
      const q    = getField(it, ["question", "問題", "query"]) || query;
      const key1 = getField(it, ["教材版回覆","教材重點","臨床流程建議","tips","summary","reply"]) || "—";
      const seg  = getField(it, ["對應脊椎分節","segments","segment"]) || "—";
      const flow = getField(it, ["臨床流程建議","flow","process"]) || "—";
      const mer  = getField(it, ["經絡與補充","meridians","meridian","經絡","經絡強補充"]) || "—";
      const ai   = getField(it, ["AI回覆","ai_reply","ai","answer"]) || "—";
      lines.push(
        `${idx === 0 ? "\n" : ""}#${idx+1} 症狀對應`,
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

function getField(obj, keys) {
  if (!obj) return "";
  for (const k of keys) if (obj[k]) return String(obj[k]);
  return "";
}

/* ====== 綁定 / 會員查詢 ====== */
async function ensureEmailForUser(userId) {
  const email = await getEmailByLineId(userId);
  if (email) return { email, justBound:false, hint:"" };
  return { email:"", justBound:false, hint:"尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com" };
}
async function getEmailByLineId(userId) {
  if (!MEMBER_DB || !userId) return "";
  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });
  if (!r?.results?.length) return "";
  const props = r.results[0]?.properties || {};
  const email = readPropEmail(props, MEMBER_EMAIL_PROP);
  return isEmail(email) ? email : "";
}
async function getMemberInfoByLineId(userId) {
  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });
  if (!r?.results?.length) return null;
  const page = r.results[0];
  const p = page.properties || {};
  const email = readPropEmail(p, MEMBER_EMAIL_PROP);
  const status = p["狀態"]?.select?.name || "";
  const level  = p["等級"]?.select?.name || "";
  const expire = p["有效日期"]?.date?.start || "";
  const lineBind = (p[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  return { email, status, level, expire, lineBind };
}
async function bindEmailToLine(userId, email) {
  if (!MEMBER_DB || !userId || !isEmail(email)) return false;
  let r = await notionQueryDatabase(MEMBER_DB, { filter: { property: MEMBER_EMAIL_PROP, email: { equals: email } }, page_size: 1 });
  if (!r?.results?.length) r = await notionQueryDatabase(MEMBER_DB, { filter: { property: MEMBER_EMAIL_PROP, rich_text: { equals: email } }, page_size: 1 });
  if (!r?.results?.length) r = await notionQueryDatabase(MEMBER_DB, { filter: { property: MEMBER_EMAIL_PROP, title: { equals: email } }, page_size: 1 });
  if (!r?.results?.length) return false;
  const page = r.results[0]; const pageId = page.id; const props = page.properties || {};
  const existing = (props[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (existing) return existing === userId;
  return await notionPatchPage(pageId, { properties: { [MEMBER_LINE_PROP]: { rich_text: [{ text: { content: userId } }] } } });
}

/* ====== Notion 共用 ====== */
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
  // ★ 修正這裡原本的壞字串（500 的主因）
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

/* ====== 紀錄 DB 寫入 / 回填 ====== */
async function writeRecord({ email, userId, category, content }) {
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
  const pageId = json?.id || "";
  if (!ok) console.error("[writeRecord] create failed", json);
  return pageId;
}
async function patchRecordById(pageId, { seg, tip }) {
  if (!pageId) return;
  const page = await notionGetPage(pageId);
  const propsNow = page?.properties || {};
  const outProps = {};
  if (typeof seg !== "undefined" && propsNow[REC_SEG]) {
    outProps[REC_SEG] = buildPropValueByType(propsNow[REC_SEG], seg ?? "");
  }
  if (typeof tip !== "undefined" && propsNow[REC_AI]) {
    outProps[REC_AI] = buildPropValueByType(propsNow[REC_AI], tip ?? "");
  }
  const keys = Object.keys(outProps);
  if (!keys.length) { console.warn("[patchRecordById] no matched properties to update"); return; }
  const ok = await notionPatchPage(pageId, { properties: outProps });
  if (!ok) console.error("[patchRecordById] failed", outProps);
}

/* ====== Notion 輔助 ====== */
async function notionGetPage(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    }
  });
  try { return await r.json(); } catch { return {}; }
}
function buildPropValueByType(propItem, value) {
  const text = String(value ?? "").slice(0, 1900);
  if (!propItem || !propItem.type) return { rich_text: [{ text: { content: text } }] };
  switch (propItem.type) {
    case "title":        return { title: [{ text: { content: text } }] };
    case "rich_text":    return { rich_text: [{ text: { content: text } }] };
    case "select": {
      const name = text.split(/[、,，\s]/).filter(Boolean)[0] || text || "—";
      return { select: { name } };
    }
    case "multi_select": {
      const names = text.split(/[、,，\s]/).filter(Boolean).slice(0, 20);
      return { multi_select: names.map(n => ({ name: n })) };
    }
    default:             return { rich_text: [{ text: { content: text } }] };
  }
}

/* ====== LINE 回覆 ====== */
async function replyText(replyToken, text) {
  if (!LINE_TOKEN) { console.warn("[replyText] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text || "").slice(0, 4900) }] })
  });
  if (!r.ok) console.error("[replyText]", r.status, await safeText(r));
}
async function replyTextQR(replyToken, text, quickList = []) {
  if (!LINE_TOKEN) { console.warn("[replyTextQR] missing LINE_CHANNEL_ACCESS_TOKEN"); return; }
  const items = (quickList || []).map(q => ({ type: "action", action: { type: "message", label: q.label, text: q.text } })).slice(0, 12);
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: String(text || "").slice(0, 4900), quickReply: items.length ? { items } : undefined }] })
  });
  if (!r.ok) console.error("[replyTextQR]", r.status, await safeText(r));
}

/* ====== HTTP / 其他 ====== */
async function postJSON(url, body, timeoutMs = 15000) {
  const ac = new AbortController(); const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", "Accept":"application/json" }, body:JSON.stringify(body||{}), signal:ac.signal });
    const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; } json.http = r.status; return json;
  } catch (e) { console.error("[postJSON]", e?.message || e); return { ok:false, error:e?.message || "fetch_failed" }; }
  finally { clearTimeout(id); }
}
async function safeText(res) { try { return await res.text(); } catch { return ""; } }
function readPropEmail(props, key) {
  if (!props || !key || !props[key]) return "";
  const e1 = props[key]?.email || "";
  if (e1 && isEmail(e1)) return e1.trim();
  const e2 = (props[key]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (e2 && isEmail(e2)) return e2;
  const e3 = (props[key]?.title || []).map(t => t?.plain_text || "").join("").trim();
  if (e3 && isEmail(e3)) return e3;
  return "";
}

/* ====== 健康檢查 / 最小寫入 ====== */
async function doHealthCheck() {
  const hasNotionKey = Boolean(NOTION_KEY);
  const hasMemberDB  = Boolean(MEMBER_DB);
  const hasRecordDB  = Boolean(RECORD_DB);
  return { ok: hasNotionKey && hasMemberDB && hasRecordDB, hasNotionKey, hasMemberDB, hasRecordDB, hasQADB: !!QA_DB_ID };
}
async function testMinimalWrite() {
  if (!RECORD_DB) return { ok:false, reason:"missing RECORD_DB_ID" };
  const nowTW = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const props = {
    [REC_TITLE]: { title: [{ text: { content: `最小寫入測試｜${nowTW}` } }] },
    [REC_EMAIL]: { email: "test@example.com" },
    [REC_UID]:   { rich_text: [{ text: { content: "TEST_LINE_USER_ID" } }] },
    [REC_CATE]:  { select: { name: "系統測試" } },
    [REC_BODY]:  { rich_text: [{ text: { content: "這是 /api/line-webhook?action=test-write 產生的測試頁" } }] },
    [REC_SRC]:   { rich_text: [{ text: { content: "LINE" } }] }
  };
  const { ok, json, status } = await notionCreatePage(RECORD_DB, props);
  return { ok, status, pageId: json?.id || null };
}

/* ====== 說明 ====== */
function helpText() {
  return [
    "可用指令：",
    "• 綁定 your@email.com",
    "• 狀態 / 我的狀態",
    "• 簽到 內容…",
    "• 心得 內容…",
    "• 主題 基礎理論（或直接輸入：基礎理論）",
    "• 顯示全部 主題 基礎理論",
    "• 直接輸入症狀關鍵字（例：肩頸、頭暈、胸悶）",
    "• debug 主題 基礎理論（測試）",
  ].join("\n");
}
function fmtDate(iso) { try { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; } catch { return iso; } }
function shortId(id) { return id ? id.replace(/-/g,"").slice(0,8) : ""; }
