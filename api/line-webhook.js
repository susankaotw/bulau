// api/line-webhook.js
// 版本：LINE UserId 為主索引（Email 僅做顯示 / 備援）
//
// 需要的環境變數：
// LINE_CHANNEL_ACCESS_TOKEN
// NOTION_API_KEY 或 NOTION_TOKEN（擇一）
// NOTION_MEMBER_DB_ID   （會員 DB）
// RECORD_DB_ID          （學員紀錄 DB，可選）
// BULAU_ANSWER_URL      （症狀查詢 API，例：https://bulau.vercel.app/api/answer）
// （可選）BULAU_GUARD_URL 仍保留作為最末備援

const ANSWER_URL = process.env.BULAU_ANSWER_URL || "https://bulau.vercel.app/api/answer";
const GUARD_URL  = process.env.BULAU_GUARD_URL  || "";
const NOTION_VER = "2022-06-28";

/* --------------------------- HTTP 入口 --------------------------- */
module.exports = async (req, res) => {
  try {
    // 新增：GET 測試入口（health / schema / test-write / dry-run）
    const action = String(req.query?.action || "").toLowerCase();
    if (req.method === "GET" && action) {
      if (action === "health") {
        const out = await httpHealth();
        return res.status(200).json(out);
      }
      if (action === "schema") {
        const out = await httpSchema();
        return res.status(200).json(out);
      }
      if (action === "test-write") {
        const out = await httpTestWrite();
        return res.status(200).json(out);
      }
      if (action === "dry-run") {
        const out = await httpDryRun();
        return res.status(200).json(out);
      }
    }

    if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("OK");
    if (req.method !== "POST") return res.status(405).json({ ok:false, reason:"method_not_allowed" });

    let body = req.body;
    if (!body || typeof body === "string") {
      let raw = typeof body === "string" ? body : await readRaw(req).catch(()=>"");
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    // 也支援 POST 的 action（方便本機 curl 測試）
    if (body && typeof body === "object" && body.__action) {
      const a = String(body.__action).toLowerCase();
      if (a === "health") return res.status(200).json(await httpHealth());
      if (a === "schema") return res.status(200).json(await httpSchema());
      if (a === "test-write") return res.status(200).json(await httpTestWrite());
      if (a === "dry-run") return res.status(200).json(await httpDryRun(body.__payload || {}));
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
};
exports.default = module.exports;

/* --------------------------- 事件處理 --------------------------- */
async function handleEvent(ev) {
  if (ev?.type !== "message" || ev?.message?.type !== "text") return;

  const replyToken = ev.replyToken;
  const userId = ev.source?.userId || "";
  const rawText = String(ev.message?.text || "").trim();
  const q = normalize(rawText);

  /* ===== 調試工具 ===== */

  // 0) debug：環境檢查
  if (/^debug$/i.test(q)) {
    const msg = renderEnvDiag();
    await replyOrPush(replyToken, userId, msg);
    return;
  }

  // 0.1) whoami：顯示目前使用者解析結果
  if (/^whoami$/i.test(q)) {
    const infoUid = await findMemberByUserId(userId);
    const emailFromUid = infoUid?.email || "";
    const g = GUARD_URL ? await postJSON(GUARD_URL, { uid: userId }, 2500) : {};
    const emailFromGuard = (g?.ok && g?.email) ? String(g.email).trim().toLowerCase() : "";

    const lines = [
      "🩺 whoami",
      `• userId: ${userId}`,
      `• Notion(email by uid): ${emailFromUid || "—"}`,
      `• guard.email: ${emailFromGuard || "—"}`,
      `• 使用欄位/型別：${infoUid?._uidProp || "—"} / ${infoUid?._uidType || "—"}`,
      `• 最終 email：${emailFromUid || emailFromGuard || "（未找到）"}`
    ];
    await replyOrPush(replyToken, userId, lines.join("\n"));
    return;
  }

  // 0.2) debug schema：列出學員紀錄 DB 欄位名與型別
  if (/^debug\s*schema$/i.test(q)) {
    const out = await httpSchema();
    const lines = ["📘 RECORD_DB schema"].concat(
      Array.isArray(out?.properties) ? out.properties.map(p => `• ${p.key} : ${p.type}`) : ["（讀不到 schema）"]
    );
    await replyOrPush(replyToken, userId, lines.join("\n"));
    return;
  }

  // 0.3) debug 記錄：先寫一筆『症狀查詢』，再回填 AI回覆測試
  if (/^debug\s*記錄$/i.test(q)) {
    const info = await requireMemberByUid(userId, replyToken);
    if (!info) return;
    await writeRecordSafe({ email: info.email, userId, category: "症狀查詢", content: "debug 測試" });
    try {
      await updateLastSymptomRecordSafe({ email: info.email, userId, seg: "T6", tip: "這是debug回填", httpCode: "200" });
      await replyOrPush(replyToken, userId, "✅ 記錄+回填 OK");
    } catch {
      await replyOrPush(replyToken, userId, "❌ 回填失敗，請用「debug schema」檢查欄位名/型別");
    }
    return;
  }

  // 0.4) debug 答 XXX：直接打 ANSWER_URL，回 http 與前 200 字原文
  const mAns = /^debug\s*答\s+(.+)$/.exec(rawText);
  if (mAns) {
    const info = await requireMemberByUid(userId, replyToken);
    if (!info) return;
    const kw = mAns[1].trim();
    const ans = await postJSON(ANSWER_URL, { q: kw, question: kw, email: info.email }, 5000);
    const http = typeof ans?.http === "number" ? ans.http : 200;
    const raw  = (typeof ans?.raw === "string" ? ans.raw : JSON.stringify(ans || {})).slice(0, 200);
    await replyOrPush(replyToken, userId, `ANSWER http=${http}\nraw=${raw}`);
    return;
  }

  // 0.5) 新增：debug 健康（等同 GET?action=health）
  if (/^debug\s*健康$/i.test(q)) {
    const out = await httpHealth();
    await replyOrPush(replyToken, userId, [
      "🩺 health",
      `ok: ${out.ok}`,
      `missing: ${out.missing_fields?.join(", ") || "—"}`
    ].join("\n"));
    return;
  }

  // 0.6) 新增：debug 寫三欄（只寫 AI回覆 / 對應脊椎分節 / 標題）
  if (/^debug\s*(寫三欄|三欄|寫入測試)$/i.test(q)) {
    const out = await httpTestWrite();
    const msg = out?.ok
      ? `✅ 最小寫入成功\nid: ${out.id}\npayload:\nAI回覆=test-ai\n對應脊椎分節=C5`
      : `❌ 最小寫入失敗\n${out?.error || ""}`;
    await replyOrPush(replyToken, userId, msg);
    return;
  }

  // 0.7) 新增：debug dry（顯示正式 properties 但不寫入）
  if (/^debug\s*dry$/i.test(q)) {
    const sample = {
      aiReply: "AI：這是dry-run示例內容。",
      spinal: "C5",
      source: "LINE Bot",
      email: "demo@example.com",
      date: new Date().toISOString().slice(0,10),
      content: "使用者輸入的原始文字",
      userId,
      category: "症狀查詢",
      title: "dry-run 測試"
    };
    const props = buildRecordProps(sample);
    await replyOrPush(replyToken, userId,
      "🧪 dry-run（不寫入）\n" +
      `AI回覆.content=${props["AI回覆"]?.rich_text?.[0]?.text?.content || "—"}\n` +
      `對應脊椎分節.content=${props["對應脊椎分節"]?.rich_text?.[0]?.text?.content || "—"}`
    );
    return;
  }

  /* ===== 正式功能 ===== */

  // 1) 綁定 email
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

  // 2) 我的狀態
  if (/^我的(狀態|帳號)$/.test(q)) {
    let info = await findMemberByUserId(userId);
    if (!info?.email && GUARD_URL) {
      const g = await postJSON(GUARD_URL, { uid: userId }, 2500);
      const email = (g?.ok && g?.email) ? String(g.email).trim().toLowerCase() : "";
      if (email) info = await findMemberByEmail(email) || info;
    }
    if (!info?.email) {
      await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
      return;
    }
    await replyOrPush(replyToken, userId, renderStatusCard(info));
    return;
  }

  // 3) 簽到
  if (/^簽到/.test(q)) {
    const content = rawText.replace(/^簽到(\s*|：|:)?/i, "").trim();
    if (!content) { await replyOrPush(replyToken, userId, "簽到 內容不能空白喔～\n例：簽到 胸椎T6呼吸 10分鐘"); return; }
    const info = await requireMemberByUid(userId, replyToken);
    if (!info) return;
    await writeRecordSafe({ email: info.email, userId, category:"簽到", content });
    await replyOrPush(replyToken, userId, `✅ 已記錄簽到：${content}\n持續練習，身體會越來越平衡🌿`);
    return;
  }

  // 4) 心得
  if (/^心得/.test(q)) {
    const content = rawText.replace(/^心得(\s*|：|:)?/i, "").trim();
    if (!content) { await replyOrPush(replyToken, userId, "心得 內容不能空白喔～\n例：心得 今天練習C1放鬆"); return; }
    const info = await requireMemberByUid(userId, replyToken);
    if (!info) return;
    await writeRecordSafe({ email: info.email, userId, category:"心得", content });
    await replyOrPush(replyToken, userId, "📝 已記錄心得！\n要不要我幫你「歸納重點」？回覆：歸納");
    return;
  }

  // 5) 其它：視為症狀查詢（多筆呈現 + 診斷寫回 Notion）
  const info = await requireMemberByUid(userId, replyToken);
  if (!info) return;

  // 先記錄查詢（不中斷）
  writeRecordSafe({ email: info.email, userId, category: "症狀查詢", content: rawText }).catch(() => {});

  // 1) 關鍵字保底
  const qPayload = q || rawText;

  // 2) 呼叫答案 API（帶 email 做授權）
  const ans = await postJSON(ANSWER_URL, { q: qPayload, question: qPayload, email: info.email }, 5000);

  // 3) 解析與多筆呈現
  const rawList = Array.isArray(ans?.results) ? ans.results
                : Array.isArray(ans?.items)   ? ans.items
                : [];

  const MAX_ITEMS = 3;
  const TIP_MAX   = 80;
  const items     = rawList.slice(0, MAX_ITEMS);

  const clamp = (s, n) => { const t = String(s || ""); return t.length > n ? (t.slice(0, n) + "…") : t; };
  const pick  = (obj, keys) => keys.map(k => obj?.[k]).find(v => !!v) || "";
  const toMeridian = (r) => Array.isArray(r?.meridians) && r.meridians.length ? r.meridians.join("、") : (r?.["經絡與補充"] || "—");
  const toSeg = (r) => r?.segments || r?.segment || r?.["對應脊椎分節"] || "—";
  const toTip = (r) => clamp(pick(r, ["tips","summary","reply","教材版回覆","臨床流程建議"]), TIP_MAX);
  const toTitle = (r) => pick(r, ["主題","問題","title","keyword"]);

  let seg = "—", tip = "—";
  let replyMsg = "";

  if (items.length) {
    const lines = [];
    lines.push(`🔎 查詢：「${qPayload}」`);
    items.forEach((r, i) => {
      const idx = i + 1;
      const header = (toTitle(r) ? `#${idx} ${toTitle(r)}` : `#${idx}`);
      const sSeg  = toSeg(r);
      const sMer  = toMeridian(r);
      const sTip  = toTip(r);
      if (i === 0) { seg = sSeg; tip = sTip; }
      lines.push(`${header}\n・對應脊椎分節：${sSeg}\n・經絡與補充：${sMer}\n・教材重點：${sTip}`);
    });
    const remain = rawList.length - items.length;
    if (remain > 0) lines.push(`…還有 ${remain} 筆結果。可加上更精準的關鍵字再試（例如：「${qPayload} 姿勢」）。`);
    replyMsg = lines.join("\n\n");
  } else if (ans?.answer?.臨床流程建議) {
    seg = ans.answer.對應脊椎分節 || "—";
    tip = ans.answer.臨床流程建議 || "—";
    replyMsg = `🔎 查詢：「${qPayload}」\n建議分節：${seg}\n臨床流程：${tip}`;
  } else {
    const httpCode = typeof ans?.http === "number" ? String(ans.http) : "";
    const diag = {
      http: httpCode || "200",
      error: ans?.error || "",
      raw: (typeof ans?.raw === "string" ? ans.raw : JSON.stringify(ans || {})).slice(0, 900)
    };
    updateLastSymptomRecordSafe({
      email: info.email, userId, seg: "", tip: `❗API 診斷：${JSON.stringify(diag)}`, httpCode: diag.http
    }).catch(() => {});
    replyMsg = `找不到「${qPayload}」的教材內容。\n可改試：肩頸、頭暈、胸悶、胃痛、腰痠。`;
  }

  // 回覆使用者
  await replyOrPush(replyToken, userId, replyMsg);

  // 成功時把第 1 筆對應分節/AI 回覆補寫回記錄
  if (replyMsg && (seg !== "—" || tip !== "—")) {
    updateLastSymptomRecordSafe({
      email: info.email, userId, seg, tip,
      httpCode: typeof ans?.http === "number" ? String(ans.http) : "200"
    }).catch(() => {});
  }
}

/* --------------------------- Notion：共用（測試用） --------------------------- */
async function httpHealth(){
  const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const DB  = process.env.RECORD_DB_ID || "";
  if (!KEY || !DB) return { ok:false, has_db:!!DB, has_key:!!KEY, missing_fields:["NOTION_KEY/RECORD_DB_ID"] };

  const props = await getDbProps(DB);
  const need = ["AI回覆","對應脊椎分節","來源","Email","日期","內容","UserId","類別","標題"];
  const missing = need.filter(k => !props[k]);
  return {
    ok: missing.length === 0,
    has_db: true,
    missing_fields: missing,
    types: Object.fromEntries(Object.entries(props).map(([k,v])=>[k,v.type])),
  };
}
async function httpSchema(){
  const DB = process.env.RECORD_DB_ID || "";
  const props = await getDbProps(DB);
  const mapped = Object.entries(props).map(([k,v])=>({ key:k, type:v.type }));
  return { ok: true, properties: mapped };
}
async function httpTestWrite(){
  const minimal = {
    "AI回覆": { rich_text: asRichText("test-ai") },
    "對應脊椎分節": { rich_text: asRichText("C5") },
    "標題": { title: asRichText(`最小寫入測試 ${new Date().toISOString()}`) },
  };
  console.log("[TEST-WRITE] props", JSON.stringify(minimal, null, 2));
  const created = await createRecord(minimal);
  return { ok:true, id: created.id };
}
async function httpDryRun(payload = {}){
  const sample = {
    aiReply: payload.aiReply || "AI：這是dry-run示例內容。",
    spinal: payload.spinal || "C5",
    source: payload.source || "LINE Bot",
    email: payload.email || "demo@example.com",
    date: payload.date || new Date().toISOString().slice(0,10),
    content: payload.content || "使用者輸入的原始文字",
    userId: payload.userId || "U_demo",
    category: payload.category || "症狀查詢",
    title: payload.title || "dry-run 測試"
  };
  const props = buildRecordProps(sample);
  console.log("[DRY-RUN] props", JSON.stringify(props, null, 2));
  return { ok:true, dry:true, properties: props };
}

/* --------------------------- 會員解析（UserId為主） --------------------------- */
async function requireMemberByUid(userId, replyToken) {
  const info = await findMemberByUserId(userId);
  if (info?.email) return info;

  if (GUARD_URL) {
    const g = await postJSON(GUARD_URL, { uid: userId }, 2500);
    const email = (g?.ok && g?.email) ? String(g.email).trim().toLowerCase() : "";
    if (email) {
      const byMail = await findMemberByEmail(email);
      if (byMail?.email) return byMail;
    }
  }
  await replyOrPush(replyToken, userId, "❗尚未綁定 Email，請輸入：綁定 email your@mail.com");
  return null;
}

/* --------------------------- Notion：會員查詢/綁定 --------------------------- */
async function getDbProps(dbId) {
  const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  if (!KEY || !dbId) return {};
  const db = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${KEY}`, "Notion-Version": NOTION_VER }
  }).then(r => r.json()).catch(() => ({}));
  return db?.properties || {};
}
function buildEqualsFilter(propName, propType, value) {
  if (propType === "title")     return { property: propName, title:     { equals: value } };
  if (propType === "rich_text") return { property: propName, rich_text: { equals: value } };
  if (propType === "email")     return { property: propName, email:     { equals: value } };
  if (propType === "url")       return { property: propName, url:       { equals: value } };
  return [
    { property: propName, rich_text: { equals: value } },
    { property: propName, title:     { equals: value } },
    { property: propName, email:     { equals: value } }
  ];
}
async function findMemberByUserId(userId) {
  const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const DB  = process.env.NOTION_MEMBER_DB_ID || "";
  if (!KEY || !DB || !userId) return null;

  const props = await getDbProps(DB);
  if (!props) return null;

  const uidPropName = props["LINE UserId"] ? "LINE UserId"
                    : Object.keys(props).find(k => /line/i.test(k) && /user/i.test(k) && /id/i.test(k));
  if (!uidPropName) return null;

  const uidPropType = props[uidPropName]?.type || "rich_text";
  const url = `https://api.notion.com/v1/databases/${DB}/query`;

  const primary = buildEqualsFilter(uidPropName, uidPropType, userId);
  const filters = Array.isArray(primary) ? primary : [primary];

  // 備援：有人把 uid 放在 title
  const titlePropName = Object.keys(props).find(k => props[k]?.type === "title");
  if (titlePropName) filters.push({ property: titlePropName, title: { equals: userId } });

  let page = null;
  for (const f of filters) {
    const j = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KEY}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ filter: f, page_size: 1 })
    }).then(r => r.json()).catch(() => null);
    if (Array.isArray(j?.results) && j.results.length) { page = j.results[0]; break; }
  }
  if (!page) return null;

  const p = page.properties || {};
  const email = p.Email?.email || (p.Email?.rich_text?.[0]?.plain_text) || pageTitleText(p[titlePropName]) || "";
  const statusName = (p["狀態"]?.status?.name) || (p["狀態"]?.select?.name) || "";
  const d = p["有效日期"]?.date || p["有效期限"]?.date;
  const expire = d ? (d.end || d.start || "").slice(0,10) : "";
  const level = p["等級"]?.select?.name ||
                (Array.isArray(p["等級"]?.multi_select) ? p["等級"].multi_select.map(x=>x.name).join(",") : "");
  return { email, statusName, expire, level, pageId: page.id, _uidProp: uidPropName, _uidType: uidPropType };
}
async function findMemberByEmail(email) {
  const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const DB  = process.env.NOTION_MEMBER_DB_ID || "";
  if (!KEY || !DB || !email) return null;

  const props = await getDbProps(DB);
  if (!props) return null;

  const url = `https://api.notion.com/v1/databases/${DB}/query`;
  const tries = [
    { filter: { property: Object.keys(props).find(k=>props[k]?.type==="title") || "名稱", title: { equals: email } }, page_size: 1 },
    { filter: { property: "Email", email: { equals: email } }, page_size: 1 },
    { filter: { property: "Email", rich_text: { equals: email } }, page_size: 1 },
  ];

  let page = null;
  for (const body of tries) {
    const j = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KEY}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(r => r.json()).catch(() => null);
    if (Array.isArray(j?.results) && j.results.length) { page = j.results[0]; break; }
  }
  if (!page) return null;

  const p = page.properties || {};
  const statusName = (p["狀態"]?.status?.name) || (p["狀態"]?.select?.name) || "";
  const d = p["有效日期"]?.date || p["有效期限"]?.date;
  const expire = d ? (d.end || d.start || "").slice(0,10) : "";
  const level = p["等級"]?.select?.name ||
                (Array.isArray(p["等級"]?.multi_select) ? p["等級"].multi_select.map(x=>x.name).join(",") : "");
  return { email, statusName, expire, level, pageId: page.id };
}
async function bindEmailToNotion(email, userId) {
  try {
    const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
    const DB  = process.env.NOTION_MEMBER_DB_ID || "";
    if (!KEY || !DB) return false;

    const props = await getDbProps(DB);
    if (!props) return false;
    const uidProp = props["LINE UserId"] ? "LINE UserId"
                  : Object.keys(props).find(k => /line/i.test(k) && /user/i.test(k) && /id/i.test(k));
    if (!uidProp) return false;

    const url = `https://api.notion.com/v1/databases/${DB}/query`;
    const titleProp = Object.keys(props).find(k=>props[k]?.type==="title") || "名稱";
    const tries = [
      { filter: { property: titleProp, title: { equals: email } }, page_size: 1 },
      { filter: { property: "Email", email: { equals: email } }, page_size: 1 },
      { filter: { property: "Email", rich_text: { equals: email } }, page_size: 1 },
    ];
    let page = null;
    for (const body of tries) {
      const r = await fetch(url, {
        method:"POST",
        headers:{ "Authorization":`Bearer ${KEY}`, "Notion-Version":NOTION_VER, "Content-Type":"application/json" },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (Array.isArray(j?.results) && j.results.length) { page = j.results[0]; break; }
    }
    if (!page) return false;

    const upd = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method:"PATCH",
      headers:{ "Authorization":`Bearer ${KEY}`, "Notion-Version":NOTION_VER, "Content-Type":"application/json" },
      body: JSON.stringify({ properties: { [uidProp]: { rich_text: [{ text: { content: userId } }] } } })
    });
    return upd.ok;
  } catch (e) {
    console.error("[bindEmail]", e?.message || e);
    return false;
  }
}

/* --------------------------- Notion：學員紀錄 --------------------------- */
function asRichText(v, max = 1900) {
  const s = String(v ?? "").trim().replace(/\u0000/g, "");
  return s ? [{ type: "text", text: { content: s.slice(0, max) } }] : [];
}
function buildRecordProps(raw) {
  const props = {
    "來源":   { rich_text: asRichText(raw.source) },
    "Email":  { email: String(raw.email || "") || null },
    "日期":   raw.date ? { date: { start: String(raw.date) } } : { date: null },
    "內容":   { rich_text: asRichText(raw.content) },
    "UserId": { rich_text: asRichText(raw.userId) },
    "類別":   raw.category ? { select: { name: String(raw.category) } } : undefined,
    "標題":   { title: asRichText(raw.title || "LINE 紀錄") },

    // 關鍵兩欄最後塞
    "AI回覆":       { rich_text: asRichText(raw.aiReply) },
    "對應脊椎分節": { rich_text: asRichText(raw.spinal) },
  };

  // 送出前 log
  console.log("[will write] AI回覆.len=", String(raw.aiReply ?? "").length,
              "preview=", String(raw.aiReply ?? "").slice(0, 60));
  console.log("[will write] 對應脊椎分節=", raw.spinal);
  console.log("[final props][AI回覆]", JSON.stringify(props["AI回覆"], null, 2));
  console.log("[final props][對應脊椎分節]", JSON.stringify(props["對應脊椎分節"], null, 2));

  return props;
}
async function createRecord(properties) {
  const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  const DB  = process.env.RECORD_DB_ID || "";
  if (!KEY || !DB) throw new Error("Missing NOTION_KEY/RECORD_DB_ID");
  const r = await fetch("https://api.notion.com/v1/pages", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${KEY}`, "Notion-Version":NOTION_VER, "Content-Type":"application/json" },
    body: JSON.stringify({ parent: { database_id: DB }, properties })
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("[notion create] http", r.status, t);
    throw new Error(`notion create failed ${r.status}`);
  }
  return r.json();
}

async function writeRecordSafe({ email, userId, category, content }) {
  try {
    const nowISO = new Date().toISOString();
    const payload = {
      parent: { database_id: process.env.RECORD_DB_ID },
      properties: {
        "標題":  { title: [{ text: { content: `${category}｜${new Date(nowISO).toLocaleString("zh-TW",{ timeZone:"Asia/Taipei" })}` } }] },
        "Email": { email },
        "UserId": { rich_text: [{ text: { content: userId } }] },
        "類別":  { select: { name: category } },
        "內容":  { rich_text: [{ text: { content } }] },
        "日期":  { date: { start: nowISO } },
        "來源":  { rich_text: [{ text: { content: "LINE" } }] }
      }
    };

    console.log("[create record minimal] properties", JSON.stringify(payload.properties, null, 2));

    const r = await fetch("https://api.notion.com/v1/pages", {
      method:"POST",
      headers:{ "Authorization":`Bearer ${process.env.NOTION_API_KEY || process.env.NOTION_TOKEN}`, "Notion-Version":NOTION_VER, "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.error("[notion create] http", r.status, await r.text());
  } catch (e) {
    console.error("[writeRecordSafe]", e?.message || e);
  }
}

async function updateLastSymptomRecordSafe({ email, userId, seg, tip, httpCode }) {
  try {
    const KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
    const DB  = process.env.RECORD_DB_ID || "";
    if (!KEY || !DB) return;

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

    const list = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method:"POST",
      headers:{ "Authorization":`Bearer ${KEY}`, "Notion-Version":NOTION_VER, "Content-Type":"application/json" },
      body: JSON.stringify(q)
    }).then(r=>r.json());

    const page = Array.isArray(list?.results) && list.results[0];
    if (!page) return;

    const patch = {
      properties: {
        ...(seg      ? { "對應脊椎分節": { rich_text: [{ text: { content: String(seg) } }] } } : {}),
        ...(tip      ? { "AI回覆":     { rich_text: [{ text: { content: String(tip).slice(0, 1900) } }] } } : {}),
        ...(httpCode ? { "API回應碼":   { rich_text: [{ text: { content: String(httpCode) } }] } } : {}),
      }
    };

    // 新增：送出前印出兩欄 PATCH 內容
    console.log("[PATCH props][AI回覆]", JSON.stringify(patch.properties?.["AI回覆"], null, 2));
    console.log("[PATCH props][對應脊椎分節]", JSON.stringify(patch.properties?.["對應脊椎分節"], null, 2));

    const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method:"PATCH",
      headers:{ "Authorization":`Bearer ${KEY}`, "Notion-Version":NOTION_VER, "Content-Type":"application/json" },
      body: JSON.stringify(patch)
    });
    if (!r.ok) console.error("[notion patch] http", r.status, await r.text());
  } catch (e) {
    console.error("[updateLastSymptomRecordSafe]", e?.message || e);
  }
}

/* --------------------------- 工具 --------------------------- */
function pageTitleText(titlePropObj) {
  const arr = titlePropObj?.title || [];
  return arr.map(b => b?.plain_text || "").join("").trim();
}
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
    return true;
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
  }catch(e){ console.error("[pushText_error]", e?.message||e); }
}
function renderStatusCard(info){
  return [
    "📇 你的狀態",
    `狀態：${info.statusName || "（未填）"}`,
    `到期：${info.expire || "（不限期或未填）"}`,
    `Email：${info.email || "（未填）"}`
  ].join("\n");
}
function renderEnvDiag(){
  const lineLen=(process.env.LINE_CHANNEL_ACCESS_TOKEN||"").length;
  const hasMember=!!process.env.NOTION_MEMBER_DB_ID;
  const hasRecord=!!process.env.RECORD_DB_ID;
  const hasNotion=!!(process.env.NOTION_API_KEY||process.env.NOTION_TOKEN);
  const hasAnswer=!!process.env.BULAU_ANSWER_URL;
  const hasGuard=!!process.env.BULAU_GUARD_URL;
  return [
    "🔧 環境檢查",
    `LINE_TOKEN 長度：${lineLen}`,
    `有 NOTION_KEY：${hasNotion}`,
    `有 會員DB：${hasMember}`,
    `有 紀錄DB：${hasRecord}`,
    `有 ANSWER_URL：${hasAnswer}`,
    `有 GUARD_URL：${hasGuard}`
  ].join("\n");
}
