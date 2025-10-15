// api/line-webhook.js — 全功能版（含我的狀態修正）
// 需要的環境變數：
// LINE_CHANNEL_ACCESS_TOKEN
// BULAU_GUARD_URL = https://bulau.vercel.app/api/guard
// BULAU_ANSWER_URL = https://bulau.vercel.app/api/answer
// NOTION_API_KEY 或 NOTION_TOKEN（其一）
// NOTION_MEMBER_DB_ID（會員 DB）
// RECORD_DB_ID（學員紀錄 DB，可選）

const GUARD_URL  = process.env.BULAU_GUARD_URL  || "https://bulau.vercel.app/api/guard";
const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";

async function handler(req, res) {
  try {
    if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("OK");
    if (req.method !== "POST") return res.status(405).json({ ok:false, reason:"method_not_allowed" });

    let body = req.body;
    if (!body || typeof body === "string") {
      let raw = typeof body === "string" ? body : await readRaw(req).catch(()=>"");
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    if (!events.length) return res.status(200).json({ ok:true, note:"no_events" });

    for (const ev of events) {
      await handleEvent(ev).catch(e => console.error("[event_error]", e?.message || e));
    }
    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error("[handler_crash]", e?.stack || e?.message || e);
    return res.status(200).json({ ok:false, note:"handled" });
  }
}

async function handleEvent(ev) {
  if (ev?.type !== "message" || ev?.message?.type !== "text") return;

  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";
  const rawText = String(ev.message?.text || "").trim();
  const q = normalize(rawText);

  // 0) debug
  if (/^debug$/i.test(q)) {
    const msg = renderEnvDiag();
    await replyOrPush(replyToken, userId, msg);
    return;
  }

  // 1) 綁定 email：綁定 email you@domain.com
  const m = /^綁定\s*email\s+([^\s@]+@[^\s@]+\.[^\s@]+)$/i.exec(rawText.replace(/\u3000/g," "));
  if (m) {
    const email = m[1].toLowerCase();
    const ok = await bindEmailToNotion(email, userId);
    const msg = ok
      ? `✅ 已綁定成功：${email}\n之後可直接查詢症狀。`
      : `❌ 綁定失敗：找不到該 Email 的會員，或 Notion 欄位名稱不符。`;
    await replyOrPush(replyToken, userId, msg);
    return;
  }

  // 2) 我的狀態 / 我的帳號
  if (/^我的(狀態|帳號)$/.test(q)) {
    // 先用 guard 取 email → 用 email 查；guard 失敗再用 userId 直查
    let info = null;
    const g = await postJSON(GUARD_URL, { uid: userId }, 3000);
    const emailFromGuard = (g?.ok && g?.email) ? String(g.email).trim().toLowerCase() : "";

    if (emailFromGuard) info = await findMemberByEmail(emailFromGuard);
    if (!info) info = await findMemberByUserId(userId);

    if (!info || !info.email) {
      await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
      return;
    }
    await replyOrPush(replyToken, userId, renderStatusCard(info));
    return;
  }

  // 3) 簽到 xxx
  if (/^簽到/.test(q)) {
    const content = rawText.replace(/^簽到(\s*|：|:)?/i, "").trim();
    if (!content) { await replyOrPush(replyToken, userId, "簽到 內容不能空白喔～\n例：簽到 胸椎T6呼吸 10分鐘"); return; }
    const email = await resolveEmailByUid(userId);
    if (!email) { await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com"); return; }
    await writeRecordSafe({ email, userId, category:"簽到", content });
    await replyOrPush(replyToken, userId, `✅ 已記錄簽到：${content}\n持續練習，身體會越來越平衡🌿`);
    return;
  }

  // 4) 心得 xxx
  if (/^心得/.test(q)) {
    const content = rawText.replace(/^心得(\s*|：|:)?/i, "").trim();
    if (!content) { await replyOrPush(replyToken, userId, "心得 內容不能空白喔～\n例：心得 今天練習C1放鬆"); return; }
    const email = await resolveEmailByUid(userId);
    if (!email) { await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com"); return; }
    await writeRecordSafe({ email, userId, category:"心得", content });
    await replyOrPush(replyToken, userId, "📝 已記錄心得！\n要不要我幫你「歸納重點」？回覆：歸納");
    return;
  }

  // 5) 其它：視為症狀查詢
  const email = await resolveEmailByUid(userId);
  if (!email) {
    await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
    return;
  }

  // 先記錄查詢（不中斷）
  writeRecordSafe({ email, userId, category:"症狀查詢", content: rawText }).catch(()=>{});

  // 查症狀
  const ans = await postJSON(ANSWER_URL, { q, question: q, email }, 5000);
  const results = Array.isArray(ans?.results) ? ans.results : [];

  let seg="—", tip="—", mer="—", replyMsg="";
  if (results.length) {
    const r = results[0] || {};
    seg = r.segments || r.segment || "—";
    tip = r.tips || r.summary || r.reply || "—";
    mer = (Array.isArray(r.meridians) && r.meridians.length) ? r.meridians.join("、") : "—";
    replyMsg = `🔎 查詢：「${q}」\n對應脊椎分節：${seg}\n經絡與補充：${mer}\n教材重點：${tip}`;
  } else if (ans?.answer?.臨床流程建議) {
    seg = ans.answer.對應脊椎分節 || "—";
    tip = ans.answer.臨床流程建議 || "—";
    replyMsg = `🔎 查詢：「${q}」\n建議分節：${seg}\n臨床流程：${tip}`;
  } else {
    replyMsg = `找不到「${q}」的教材內容。\n可改試：肩頸、頭暈、胸悶、胃痛、腰痠。`;
  }

  await replyOrPush(replyToken, userId, replyMsg);

  // 回填最新一筆症狀查詢結果
  updateLastSymptomRecordSafe({
    email, userId, seg, tip,
    httpCode: typeof ans?.http === "number" ? String(ans.http) : "200"
  }).catch(()=>{});
}

/* ----------------- Email 解析：guard → userId 直查 ----------------- */
async function resolveEmailByUid(userId) {
  // 先問 guard
  const g = await postJSON(GUARD_URL, { uid: userId }, 3000);
  if (g?.ok && g?.email) return String(g.email).trim().toLowerCase();

  // guard 沒給，就從 Notion 會員 DB 用 userId 直查
  const infoByUid = await findMemberByUserId(userId);
  return infoByUid?.email ? infoByUid.email.toLowerCase() : "";
}

/* ----------------- Notion：會員查詢（Email / userId） ----------------- */
// 用 Email 直查會員（支援 title/Email[email]/Email[rich_text]）
async function findMemberByEmail(email) {
  const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID || "";
  if (!NOTION_KEY || !MEMBER_DB_ID || !email) return null;

  const db = await fetch(`https://api.notion.com/v1/databases/${MEMBER_DB_ID}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": "2022-06-28" }
  }).then(r => r.json()).catch(() => null);
  const props = db?.properties || {};
  const titleProp = Object.keys(props).find(k => props[k]?.type === "title") || "名稱";

  const url = `https://api.notion.com/v1/databases/${MEMBER_DB_ID}/query`;
  const tries = [
    { filter: { property: titleProp, title: { equals: email } }, page_size: 1 },
    { filter: { property: "Email", email: { equals: email } }, page_size: 1 },
    { filter: { property: "Email", rich_text: { equals: email } }, page_size: 1 },
  ];

  let page = null;
  for (const body of tries) {
    const j = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(r => r.json()).catch(() => null);
    if (Array.isArray(j?.results) && j.results.length) { page = j.results[0]; break; }
  }
  if (!page) return null;

  const p = page.properties || {};
  const emailOut = p.Email?.email || (p.Email?.rich_text?.[0]?.plain_text) || email;
  const statusName = (p["狀態"]?.status?.name) || (p["狀態"]?.select?.name) || "";
  const d = p["有效期限"]?.date || p["有效日期"]?.date;
  const expire = d ? (d.end || d.start || "").slice(0,10) : "";
  const level = p["等級"]?.select?.name ||
                (Array.isArray(p["等級"]?.multi_select) ? p["等級"].multi_select.map(x=>x.name).join(",") : "");
  return { email: emailOut, statusName, expire, level, pageId: page.id };
}

// 用 LINE UserId 直查會員
async function findMemberByUserId(userId) {
  const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID || "";
  if (!NOTION_KEY || !MEMBER_DB_ID || !userId) return null;

  const db = await fetch(`https://api.notion.com/v1/databases/${MEMBER_DB_ID}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": "2022-06-28" }
  }).then(r => r.json()).catch(() => null);
  const props = db?.properties || {};
  const titleProp = Object.keys(props).find(k => props[k]?.type === "title") || "名稱";

  const url = `https://api.notion.com/v1/databases/${MEMBER_DB_ID}/query`;
  const tries = [
    { filter: { property: "LINE UserId", rich_text: { equals: userId } }, page_size: 1 },
    { filter: { property: titleProp, title: { equals: userId } }, page_size: 1 },
  ];

  let page = null;
  for (const body of tries) {
    const j = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(r => r.json()).catch(() => null);
    if (Array.isArray(j?.results) && j.results.length) { page = j.results[0]; break; }
  }
  if (!page) return null;

  const p = page.properties || {};
  const email = p.Email?.email || (p.Email?.rich_text?.[0]?.plain_text) || "";
  const statusName = (p["狀態"]?.status?.name) || (p["狀態"]?.select?.name) || "";
  const d = p["有效期限"]?.date || p["有效日期"]?.date;
  const expire = d ? (d.end || d.start || "").slice(0,10) : "";
  const level = p["等級"]?.select?.name ||
                (Array.isArray(p["等級"]?.multi_select) ? p["等級"].multi_select.map(x=>x.name).join(",") : "");
  return { email, statusName, expire, level, pageId: page.id };
}

/* ----------------- 綁定 email → 寫 LINE UserId ----------------- */
async function bindEmailToNotion(email, userId) {
  try {
    const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
    const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID || "";
    if (!NOTION_KEY || !MEMBER_DB_ID) return false;

    const db = await fetch(`https://api.notion.com/v1/databases/${MEMBER_DB_ID}`, {
      method:"GET",
      headers:{ "Authorization":`Bearer ${NOTION_KEY}`, "Notion-Version":"2022-06-28" }
    }).then(r=>r.json()).catch(()=>null);
    const props = db?.properties || {};
    let titlePropName = Object.keys(props).find(k => props[k]?.type === "title") || "名稱";

    const url = `https://api.notion.com/v1/databases/${MEMBER_DB_ID}/query`;
    const tryBodies = [
      { filter: { property: titlePropName, title: { equals: email } }, page_size: 1 },
      { filter: { property: "Email", email: { equals: email } }, page_size: 1 },
      { filter: { property: "Email", rich_text: { equals: email } }, page_size: 1 },
    ];

    let page = null;
    for (const body of tryBodies) {
      const r = await fetch(url, {
        method:"POST",
        headers:{
          "Authorization":`Bearer ${NOTION_KEY}`,
          "Notion-Version":"2022-06-28",
          "Content-Type":"application/json"
        },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (Array.isArray(j?.results) && j.results.length) { page = j.results[0]; break; }
    }
    if (!page) return false;

    const update = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method:"PATCH",
      headers:{
        "Authorization":`Bearer ${NOTION_KEY}`,
        "Notion-Version":"2022-06-28",
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        properties: { "LINE UserId": { rich_text: [{ text: { content: userId } }] } }
      })
    });
    return update.ok;
  } catch (e) {
    console.error("[bindEmail]", e?.message || e);
    return false;
  }
}

/* ----------------- Notion 記錄（寫入 / 回填） ----------------- */
async function writeRecordSafe({ email, userId, category, content }) {
  try {
    const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
    const RECORD_DB_ID = process.env.RECORD_DB_ID || "";
    if (!NOTION_KEY || !RECORD_DB_ID) return;

    const nowISO = new Date().toISOString();
    const payload = {
      parent: { database_id: RECORD_DB_ID },
      properties: {
        "標題": { title: [{ text: { content: `${category}｜${new Date(nowISO).toLocaleString("zh-TW",{ timeZone:"Asia/Taipei" })}` } }] },
        "Email": { email },
        "UserId": { rich_text: [{ text: { content: userId } }] },
        "類別": { select: { name: category } },
        "內容": { rich_text: [{ text: { content } }] },
        "日期": { date: { start: nowISO } },
        "來源": { rich_text: [{ text: { content: "LINE" } }] }
      }
    };

    const r = await fetch("https://api.notion.com/v1/pages", {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${NOTION_KEY}`,
        "Notion-Version":"2022-06-28",
        "Content-Type":"application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.error("[notion create] http", r.status, await r.text());
  } catch (e) {
    console.error("[writeRecordSafe]", e?.message || e);
  }
}

async function updateLastSymptomRecordSafe({ email, userId, seg, tip, httpCode }) {
  try {
    const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
    const RECORD_DB_ID = process.env.RECORD_DB_ID || "";
    if (!NOTION_KEY || !RECORD_DB_ID) return;

    const q = {
      filter: {
        and: [
          { property: "Email", email: { equals: email } },
          { property: "UserId", rich_text: { equals: userId } },
          { property: "類別", select: { equals: "症狀查詢" } }
        ]
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 1
    };

    const list = await fetch(`https://api.notion.com/v1/databases/${RECORD_DB_ID}/query`, {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${NOTION_KEY}`,
        "Notion-Version":"2022-06-28",
        "Content-Type":"application/json"
      },
      body: JSON.stringify(q)
    }).then(r=>r.json());

    const page = Array.isArray(list?.results) && list.results[0];
    if (!page) return;

    const patch = {
      properties: {
        ...(seg ? { "對應脊椎分節": { rich_text: [{ text: { content: seg } }] } } : {}),
        ...(tip ? { "AI回覆": { rich_text: [{ text: { content: String(tip).slice(0, 2000) } }] } } : {}),
        ...(httpCode ? { "API回應碼": { rich_text: [{ text: { content: httpCode } }] } } : {}),
      }
    };

    const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method:"PATCH",
      headers:{
        "Authorization":`Bearer ${NOTION_KEY}`,
        "Notion-Version":"2022-06-28",
        "Content-Type":"application/json"
      },
      body: JSON.stringify(patch)
    });
    if (!r.ok) console.error("[notion patch] http", r.status, await r.text());
  } catch (e) {
    console.error("[updateLastSymptomRecordSafe]", e?.message || e);
  }
}

/* ----------------- 基礎工具 ----------------- */
function normalize(s){ if(!s) return ""; let t=String(s).replace(/\u3000/g," ").replace(/\s+/g,""); if(t==="肩") t="肩頸"; return t; }

function readRaw(req){ return new Promise((resolve)=>{ let data=""; req.on("data",c=>data+=c); req.on("end",()=>resolve(data)); req.on("error",()=>resolve("")); }); }

async function postJSON(url, body, timeoutMs=5000){
  const ac=new AbortController(); const id=setTimeout(()=>ac.abort(), timeoutMs);
  try{
    const r = await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json","Accept":"application/json" }, body:JSON.stringify(body), signal:ac.signal });
    const txt=await r.text(); let json; try{ json=JSON.parse(txt);}catch{ json={raw:txt}; }
    if(!r.ok) json.http = r.status; return json;
  }catch(e){ console.error("[postJSON_error]", url, e?.message||e); return { ok:false, error:"fetch_failed" }; }
  finally{ clearTimeout(id); }
}

async function replyOrPush(replyToken, userId, text){
  const ok = await replyText(replyToken, text);
  if(!ok && userId) await pushText(userId, text);
}

async function replyText(replyToken, text){
  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  try{
    const r = await fetch("https://api.line.me/v2/bot/message/reply",{
      method:"POST",
      headers:{ "Content-Type":"application/json","Authorization":`Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ replyToken, messages:[{ type:"text", text:String(text).slice(0,4900) }] })
    });
    if(!r.ok){ const t=await r.text(); console.error("[replyText] http", r.status, t, "len=", LINE_TOKEN.length); return false; }
    console.log("[replyText] ok len=", LINE_TOKEN.length); return true;
  }catch(e){ console.error("[replyText_error]", e?.message||e); return false; }
}

async function pushText(to, text){
  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  try{
    const r = await fetch("https://api.line.me/v2/bot/message/push",{
      method:"POST",
      headers:{ "Content-Type":"application/json","Authorization":`Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ to, messages:[{ type:"text", text:String(text).slice(0,4900) }] })
    });
    if(!r.ok) console.error("[pushText] http", r.status, await r.text(), "len=", LINE_TOKEN.length);
    else console.log("[pushText] ok len=", LINE_TOKEN.length);
  }catch(e){ console.error("[pushText_error]", e?.message||e); }
}

function renderEnvDiag(){
  const lineLen=(process.env.LINE_CHANNEL_ACCESS_TOKEN||"").length;
  const keysLikeLine=Object.keys(process.env).filter(k=>k.includes("LINE")).slice(0,20);
  const hasGuard=!!process.env.BULAU_GUARD_URL;
  const hasAnswer=!!process.env.BULAU_ANSWER_URL;
  const hasNotion=!!(process.env.NOTION_API_KEY||process.env.NOTION_TOKEN);
  const hasMember=!!process.env.NOTION_MEMBER_DB_ID;
  const hasRecord=!!process.env.RECORD_DB_ID;
  return [
    "🔧 環境檢查",
    `LINE_TOKEN 長度：${lineLen}`,
    `有 GUARD_URL：${hasGuard}`,
    `有 ANSWER_URL：${hasAnswer}`,
    `有 NOTION_KEY：${hasNotion}`,
    `有 MEMBER_DB_ID：${hasMember}`,
    `有 RECORD_DB_ID：${hasRecord}`,
    `keys(含 LINE)：${keysLikeLine.join(", ")||"—"}`
  ].join("\n");
}

/* 匯出 */
module.exports = handler;
export default handler;
