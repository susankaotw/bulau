// api/answer.js
// 查詢版（支援多筆 + 會員Email檢核）

const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_ID = process.env.NOTION_DB_ID;                // QA 主資料庫
const MEMBER_DB = process.env.NOTION_MEMBER_DB_ID;     // 會員名單資料庫（必填以啟用檢核）
const JOIN_URL = process.env.JOIN_URL || "";

// ---------- 小工具 ----------
const rtText = (prop) => (prop?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
const titleText = (prop) => (prop?.title || []).map(t => t?.plain_text || "").join("").trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||""));

function guessTopic(q) {
  if (!q) return null;
  if (/肩|頸/.test(q)) return "症狀對應";
  if (/手|臂|肘|上肢/.test(q)) return "上肢";
  if (/腰|背|下背/.test(q)) return "腰背";
  if (/膝|腿|下肢/.test(q)) return "下肢";
  return null;
}

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

// ---------- 會員檢核 ----------
async function checkMember(email){
  if (!MEMBER_DB) {
    // 未設定會員DB時，為避免誤鎖全部，預設放行；要強制一定檢核可改成 return { ok:false, reason:"未設定會員DB" }
    return { ok: true, level: "" };
  }
  // 以 Email 型別查
  let r = await notion.databases.query({
    database_id: MEMBER_DB,
    filter: { property: "Email", email: { equals: email } },
    page_size: 1
  });
  // 後備：Email 欄若被建成 Rich text
  if (!r.results?.length) {
    r = await notion.databases.query({
      database_id: MEMBER_DB,
      filter: { property: "Email", rich_text: { equals: email } },
      page_size: 1
    });
  }
  if (!r.results?.length) return { ok: false, reason: "not_found" };

  const p = r.results[0].properties || {};
  const statusName =
    (p["狀態"]?.status?.name) ||
    (p["狀態"]?.select?.name) || "";
  const statusOK = !statusName || statusName === "啟用";

  // 到期檢查（空白視為不限期）
  let expired = false;
  const d = p["有效期限"]?.date;
  if (d) {
    const end = d.end || d.start;
    if (end) expired = new Date(end).getTime() < Date.now();
  }

  if (!statusOK)   return { ok:false, reason:"disabled" };
  if (expired)     return { ok:false, reason:"expired" };

  const level =
    p["等級"]?.select?.name ||
    (p["等級"]?.multi_select || []).map(x=>x.name).join(",") || "";
  return { ok:true, level };
}

// ---------- 主處理 ----------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question, 問題 } = req.body || {};
    if (!isEmail(email)) {
      return res.status(400).json({ error: "請輸入有效 Email 才能使用。" });
    }

    // 會員檢核
    const gate = await checkMember(email);
    if (!gate.ok) {
      const msg =
        gate.reason === "not_found" ? "此 Email 不在會員名單中。"
      : gate.reason === "disabled" ? "帳號已停用，如需啟用請聯繫我們。"
      : gate.reason === "expired"  ? "您的會員已到期，請續約後再使用。"
      : "目前無法驗證您的資格。";
      return res.status(403).json({
        error: JOIN_URL ? `${msg} 申請/續約：${JOIN_URL}` : msg
      });
    }

    const q = String(question ?? 問題 ?? "").trim();
    if (!q) return res.status(400).json({ error: "question is required" });

    const key = q.length > 16 ? q.slice(0, 16) : q;

    // 依序嘗試：Title → Rich → 主題保底
    let results = [];
    let resp = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "問題", title: { contains: key } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 10
    });
    results = resp.results;

    if (!results?.length) {
      resp = await notion.databases.query({
        database_id: DB_ID,
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
          database_id: DB_ID,
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
        email,
        answer: "查不到相符條目，請改用其他關鍵字（例：肩頸痠痛、手舉不起來）。",
        matched: null, version: null, updated_at: null, count: 0, items: []
      });
    }

    const N = 5; // 顯示前 N 筆
    const items = results.slice(0, N).map(pageToItem);

    return res.json({
      mode: "查詢",
      email,
      matched: key,
      count: items.length,
      items,
      // 相容：仍帶第一筆到舊欄位
      answer: items[0],
      version: items[0].version,
      updated_at: items[0].updated_at
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
