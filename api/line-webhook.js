// api/line-webhook.js — Production-ready + 綁定 email 指令
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

  // 1) 綁定 email 指令：綁定 email you@domain.com
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

  // 2) 以 userId 換 email（/api/guard）
  const guard = await postJSON(GUARD_URL, { uid: userId }, 3500);
  const email = guard?.ok && guard?.email ? String(guard.email).trim().toLowerCase() : "";
  if (!email) {
    await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
    return;
  }

  // 3) 查症狀（/api/answer）
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

  // 4) 背景寫 Notion（可選）
  const NOTION_KEY   = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const RECORD_DB_ID = process.env.RECORD_DB_ID || "";
  if (NOTION_KEY && RECORD_DB_ID) {
    writeRecord({
      email, userId, category:"症狀查詢", content: rawText,
      seg, tip, statusCode: typeof ans?.http === "number" ? String(ans.http) : "200",
      NOTION_KEY, RECORD_DB_ID
    }).catch(e => console.error("[writeRecord]", e?.message || e));
  }
}

/* ---------- 綁定 email 到 Notion 會員 DB ---------- */
async function bindEmailToNotion(email, userId) {
  try {
    const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
    const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID || "";
    if (!NOTION_KEY || !MEMBER_DB_ID) return false;

    // 1) 讀 DB schema 找出 title 欄位名稱（有些人把 Email 放在 title）
    const db = await fetch(`https://api.notion.com/v1/databases/${MEMBER_DB_ID}`, {
      method:"GET",
      headers:{
        "Authorization":`Bearer ${NOTION_KEY}`,
        "Notion-Version":"2022-06-28"
      }
    }).then(r=>r.json()).catch(()=>null);
    const props = db?.properties || {};
    let titlePropName = Object.keys(props).find(k => props[k]?.type === "title") || "名稱";

    // 2) 依序嘗試三種篩選：title === email、Email[email]、Email[rich_text]
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

    // 3) 更新該頁面的「LINE UserId」欄位
    const update = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method:"PATCH",
      headers:{
        "Authorization":`Bearer ${NOTION_KEY}`,
        "Notion-Version":"2022-06-28",
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        properties: {
          "LINE UserId": { rich_text: [{ text: { content: userId } }] }
        }
      })
    });
    return update.ok;
  } catch (e) {
    console.error("[bindEmail]", e?.message || e);
    return false;
  }
}

/* ---------- 基礎工具 ---------- */

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

/* CJS + ESM */
module.exports = handler;
export default handler;
