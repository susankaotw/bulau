// api/answer.js
// 查詢版（多筆 + 強制會員Email檢核 + 自動偵測欄位 + 在地化錯誤）

const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const QA_DB_ID     = process.env.NOTION_DB_ID;            // QA 主資料庫（必填）
const MEMBER_DB_ID = process.env.NOTION_MEMBER_DB_ID;     // 會員名單資料庫（必填）
const JOIN_URL     = process.env.JOIN_URL || "";

// ---------- 工具 ----------
const rtText = (prop) => (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
const titleText = (prop) => (prop?.title || []).map(t => t?.plain_text || "").join("").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||""));
const toLower = (s) => String(s||"").trim().toLowerCase();

// 題目主題保底
function guessTopic(q) {
  if (!q) return null;
  if (/肩|頸/.test(q)) return "症狀對應";
  if (/手|臂|肘|上肢/.test(q)) return "上肢";
  if (/腰|背|下背/.test(q)) return "腰背";
  if (/膝|腿|下肢/.test(q)) return "下肢";
  return null;
}

// QA page -> 前端需要的結構
function pageToItem(page){
  const p = page.properties || {};
  return {
    主題: p["主題"]?.select?.name || "",
    問題: titleText(p["問題"]) || rtText(p["問題"]) || "",
    教材版回覆: rtText(p["教材版回覆"]),
    臨床流程建議: rtText(p["臨床流程建議"]),
    對應脊椎分節: rtText(p["對應脊椎分節"]),
    經絡與補充: rtText(p["經絡與補充"]),
    version: p["版本號"]?.rich_text?.[0]?.plain_text || rtText(p["版本號"]) || "v1.0.0",
    updated_at: page.last_edited_time,
    id: page.id
  };
}

// ---------- 會員DB欄位偵測（快取） ----------
let memberFieldCache = null;
/** 回傳 { email: {name, type}, statusName, expiryName, levelName } */
async function detectMemberFields() {
  if (memberFieldCache) return memberFieldCache;
  const meta = await notion.databases.retrieve({ database_id: MEMBER_DB_ID });
  const props = meta.properties || {};

  // 1) Email 欄位（優先 type=email；否則名稱含 email/e-mail/mail/信箱/電子郵件/邮箱）
  const emailNameKeywords = /(email|e-mail|mail|信箱|電子郵件|邮箱)/i;
  let emailField = null;
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === "email") { emailField = { name, type: "email" }; break; }
  }
  if (!emailField) {
    for (const [name, def] of Object.entries(props)) {
      if (emailNameKeywords.test(name)) {
        const t = def?.type;
        if (t === "rich_text" || t === "title" || t === "formula") {
          emailField = { name, type: t };
          break;
        }
      }
    }
  }

  // 2) 狀態欄位（status/select，名稱含 狀態/status）
  let statusName = null;
  for (const [name, def] of Object.entries(props)) {
    const t = def?.type;
    if ((t === "status" || t === "select") && /(狀態|status)/i.test(name)) { statusName = name; break; }
  }

  // 3) 到期欄位（date，名稱含 有效/期限/到期/expire/expiry）
  let expiryName = null;
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === "date" && /(有效|期限|到期|expire|expiry)/i.test(name)) { expiryName = name; break; }
  }

  // 4) 等級欄位（select/multi_select，名稱含 等級/級別/level）
  let levelName = null;
  for (const [name, def] of Object.entries(props)) {
    const t = def?.type;
    if ((t === "select" || t === "multi_select") && /(等級|級別|level)/i.test(name)) { levelName = name; break; }
  }

  memberFieldCache = { email: emailField, statusName, expiryName, levelName };
  return memberFieldCache;
}

// ---------- 會員檢核（硬性） ----------
async function checkMember(email){
  if (!MEMBER_DB_ID) return { ok:false, reason:"member_db_missing" };

  const fields = await detectMemberFields();
  if (!fields.email) return { ok:false, reason:"email_field_missing" };

  const emailField = fields.email;

  // 先用 Notion 過濾抓一波
  let r;
  if (emailField.type === "email") {
    r = await notion.databases.query({
      database_id: MEMBER_DB_ID,
      filter: { property: emailField.name, email: { equals: email } },
      page_size: 5
    });
  } else { // rich_text 或 title
    r = await notion.databases.query({
      database_id: MEMBER_DB_ID,
      filter: { property: emailField.name, rich_text: { contains: email } },
      page_size: 10
    });
  }
  if (!r.results?.length) return { ok:false, reason:"not_found" };

  // 再做一次「精準比對」
  const hit = r.results.find(pg => {
    const prop = pg.properties[emailField.name];
    const val = (emailField.type === "email")
      ? (prop?.email || "")
      : (emailField.type === "title" ? titleText(prop) : rtText(prop));
    return toLower(val) === toLower(email);
  });
  if (!hit) return { ok:false, reason:"not_found" };

  const p = hit.properties || {};

  // 狀態：只擋不在啟用/可用/有效/Active/Enabled 的情況；找不到欄位就略過
  if (fields.statusName) {
    const sv = p[fields.statusName];
    const sname = (sv?.status?.name) || (sv?.select?.name) || "";
    if (sname && !/^(啟用|可用|有效|active|enabled)$/i.test(sname)) {
      return { ok:false, reason:"disabled" };
    }
  }

  // 有效期限：到期才擋；空白視為不限期；找不到欄位就略過
  if (fields.expiryName) {
    const d = p[fields.expiryName]?.date;
    if (d) {
      const end = d.end || d.start;
      if (end && new Date(end).getTime() < Date.now()) {
        return { ok:false, reason:"expired" };
      }
    }
  }

  // 等級（僅供參考）
  let level = "";
  if (fields.levelName) {
    const lv = p[fields.levelName];
    level = lv?.select?.name || (lv?.multi_select || []).map(x=>x.name).join(",") || "";
  }

  return { ok:true, level };
}

// ---------- 主處理 ----------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!process.env.NOTION_TOKEN || !QA_DB_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question, 問題 } = req.body || {};

    // Email 檢核：空白 / 格式
    const emailStr = String(email || "").trim();
    if (!emailStr) return res.status(400).json({ error: "請輸入email" });
    if (!isEmail(emailStr)) return res.status(400).json({ error: "email檢錯誤" });

    // 會員資格（硬性）
    const gate = await checkMember(emailStr);
    if (!gate.ok) {
      const reason = gate.reason || "unknown";
      const msg =
        reason === "member_db_missing"   ? "系統尚未設定會員名單，請聯絡管理員。"
      : reason === "email_field_missing" ? "會員名單缺少 Email 欄位。"
      : reason === "not_found"           ? "此 Email 不在會員名單中。"
      : reason === "disabled"            ? "帳號已停用，如需啟用請聯繫我們。"
      : reason === "expired"             ? "您的會員已到期，請續約後再使用。"
      : "目前無法驗證您的資格。";
      return res.status(403).json({
        error: JOIN_URL ? `${msg} 申請/續約：${JOIN_URL}` : msg,
        member_reason: reason
      });
    }

    // 問題檢核
    const q = String(question ?? 問題 ?? "").trim();
    if (!q) return res.status(400).json({ error: "請輸入關鍵字" });

    const key = q.length > 16 ? q.slice(0, 16) : q;

    // 查詢 QA：Title → Rich text → 主題保底
    let results = [];
    let resp = await notion.databases.query({
      database_id: QA_DB_ID,
      filter: { property: "問題", title: { contains: key } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 10
    });
    results = resp.results;

    if (!results?.length) {
      resp = await notion.databases.query({
        database_id: QA_DB_ID,
        filter: { property: "問題", rich_text: { contains: key } },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 10
      });
      results = resp.results;
    }

    if (!results?.length) {
      const topic = guessTopic(q);
      if (topic) {
        resp = await notion.databases.query({
          database_id: QA_DB_ID,
          filter: { property: "主題", select: { equals: topic } },
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          page_size: 10
        });
        results = resp.results;
      }
    }

    if (!results?.length) {
      return res.json({
        mode: "查詢",
        email: emailStr,
        answer: "查不到相符條目，請改用其他關鍵字（例：肩頸痠痛、手舉不起來）。",
        matched: null, version: null, updated_at: null, count: 0, items: []
      });
    }

    const N = 5;
    const items = results.slice(0, N).map(pageToItem);

    return res.json({
      mode: "查詢",
      email: emailStr,
      matched: key,
      count: items.length,
      items,
      answer: items[0],
      version: items[0].version,
      updated_at: items[0].updated_at
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
