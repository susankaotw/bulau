// api/answer.js
// 不老 AI Router 查詢版 V2
// 支援：會員 Email 檢核、Router 判斷、Notion 教學知識庫查詢、命中排序、回傳 line-webhook 可讀的 items 格式

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_ID = process.env.NOTION_DB_ID;                // 不老資料庫 / 教學知識庫
const MEMBER_DB = process.env.NOTION_MEMBER_DB_ID;     // 會員資料庫
const JOIN_URL = process.env.JOIN_URL || "";

// ---------- 基本工具 ----------
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const clean = (s) => String(s || "").trim();

function taipeiTodayYMD() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractExpireDateYMD(p) {
  const d1 = p["有效日期"]?.date;
  const d2 = p["有效期限"]?.date;
  const d = d1 || d2;
  if (!d) return null;
  const end = d.end || d.start;
  if (!end) return null;
  return String(end).slice(0, 10);
}

// ---------- 會員檢核 ----------
async function checkMember(email) {
  if (!MEMBER_DB) {
    return { ok: true, level: "" };
  }

  let r = await notion.databases.query({
    database_id: MEMBER_DB,
    filter: { property: "Email", email: { equals: email } },
    page_size: 1
  });

  if (!r.results?.length) {
    r = await notion.databases.query({
      database_id: MEMBER_DB,
      filter: { property: "Email", rich_text: { equals: email } },
      page_size: 1
    });
  }

  if (!r.results?.length) {
    r = await notion.databases.query({
      database_id: MEMBER_DB,
      filter: { property: "Email", title: { equals: email } },
      page_size: 1
    });
  }

  if (!r.results?.length) return { ok: false, reason: "not_found" };

  const p = r.results[0].properties || {};

  const statusName =
    p["狀態"]?.status?.name ||
    p["狀態"]?.select?.name ||
    "";

  if (["停用", "封鎖", "黑名單", "禁用", "已過期"].includes(statusName)) {
    return { ok: false, reason: "disabled" };
  }

  if (statusName && statusName !== "啟用" && statusName !== "測試") {
    return { ok: false, reason: "disabled" };
  }

  const today = taipeiTodayYMD();
  const expireYMD = extractExpireDateYMD(p);
  if (expireYMD && expireYMD < today) {
    return { ok: false, reason: "expired" };
  }

  const level =
    p["等級"]?.select?.name ||
    (p["等級"]?.multi_select || []).map(x => x.name).join(",") ||
    "";

  return { ok: true, level };
}

// ---------- Router：判斷使用者意圖 ----------
function detectIntent(text) {
  const t = clean(text);

  if (/骨折|腫瘤|癌|急性|發炎|感染|骨鬆|骨質疏鬆|打釘|開刀|凝血|類風濕|嚴重|可以做嗎|能做嗎|能不能做|適合嗎/.test(t)) {
    return "禁忌風險";
  }

  if (/PD|pd|長短腳|腳長|左PD|右PD|姿勢偏差|骨盆下沉|怎麼判斷|判斷流程|問診|評估/.test(t)) {
    return "判斷流程";
  }

  if (/C[1-7]|T[1-9]|T1[0-2]|L[1-5]|薦椎|尾椎|骨盆/.test(t)) {
    return "分節查詢";
  }

  if (/為什麼不打痛點|不打痛點|打一邊|為什麼打一邊|多久|一次多久|會痠|好痠|第一次比較久|筋膜槍|活化槍|專業型筋膜槍/.test(t)) {
    return "QA教學";
  }

  if (/痛|痠|酸|麻|卡|緊|無力|頭暈|頭痛|耳鳴|失眠|肩|頸|腰|背|腳|手|膝|足底|坐骨神經/.test(t)) {
    return "症狀對應";
  }

  if (/什麼是|原理|差異|半脫位|神經|脊椎|筋膜|修復|自我修復|結構平衡/.test(t)) {
    return "核心觀念";
  }

  return "教材查詢";
}

// ---------- 關鍵字抽取 ----------
function extractKeywords(text) {
  const t = clean(text);
  const keywords = [];

  const patterns = [
    "PD怎麼判斷",
    "PD判斷",
    "PD檢測",
    "PD腳",
    "腳檢測",
    "骨盆下沉",

    "為什麼不打痛點",
    "不打痛點",
    "打一邊",
    "為什麼打一邊",
    "剛打完覺得好痠",
    "會痠",
    "好痠",
    "多久打一次",
    "第一次比較久",

    "半脫位",
    "動態半脫位",
    "靜態半脫位",
    "神經",
    "脊椎",
    "筋膜",
    "修復機制",
    "自我修復",

    "PD",
    "長短腳",
    "姿勢偏差",
    "骨盆下沉",
    "問診",
    "評估",

    "頭痛",
    "頭暈",
    "耳鳴",
    "失眠",
    "落枕",
    "肩痛",
    "肩頸",
    "手麻",
    "腰痛",
    "背痛",
    "膝蓋痛",
    "坐骨神經",
    "足底筋膜",
    "腳跟痛",

    "骨折",
    "腫瘤",
    "急性發炎",
    "發炎",
    "骨質疏鬆",
    "骨鬆",
    "感染",
    "打釘",
    "開刀",

    "筋膜槍",
    "活化槍",
    "專業型筋膜槍",

    "C1", "C2", "C3", "C4", "C5", "C6", "C7",
    "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12",
    "L1", "L2", "L3", "L4", "L5",
    "薦椎", "尾椎", "骨盆"
  ];

  for (const p of patterns) {
    if (t.includes(p)) keywords.push(p);
  }

  const segs = t.match(/\b(C[1-7]|T[1-9]|T1[0-2]|L[1-5])\b/g);
  if (segs) {
    for (const s of segs) {
      if (!keywords.includes(s)) keywords.push(s);
    }
  }

  return [...new Set(keywords)];
}

// ---------- Notion 欄位讀取 ----------
function getTextFromPage(page, key) {
  const prop = page?.properties?.[key];
  if (!prop) return "";

  if (prop.type === "title") {
    return prop.title?.map(t => t.plain_text).join("").trim() || "";
  }

  if (prop.type === "rich_text") {
    return prop.rich_text?.map(t => t.plain_text).join("").trim() || "";
  }

  if (prop.type === "select") {
    return prop.select?.name || "";
  }

  if (prop.type === "multi_select") {
    return prop.multi_select?.map(x => x.name).join("、") || "";
  }

  if (prop.type === "checkbox") {
    return prop.checkbox ? "是" : "否";
  }

  if (prop.type === "date") {
    return prop.date?.start || "";
  }

  return "";
}

function pageToItemForLine(page, intent = "") {
  const title = getTextFromPage(page, "問題");
  const type = getTextFromPage(page, "類型") || intent || "查詢結果";
  const topic = getTextFromPage(page, "主題");
  const material = getTextFromPage(page, "教材版回覆");
  const aiTeach = getTextFromPage(page, "AI教學說法");
  const segment = getTextFromPage(page, "對應脊椎分節");
  const bodyArea = getTextFromPage(page, "身體區域");
  const flow = getTextFromPage(page, "臨床流程建議");
  const process = getTextFromPage(page, "判斷流程");
  const talk = getTextFromPage(page, "客戶溝通話術");
  const meridian = getTextFromPage(page, "經絡與補充");
  const risk = getTextFromPage(page, "風險提醒");
  const contraindication = getTextFromPage(page, "禁忌標記");
  const version = getTextFromPage(page, "版本號") || "router-v2";

  const aiReplyParts = [];
  if (aiTeach) aiReplyParts.push(aiTeach);
  if (talk) aiReplyParts.push(`溝通說法：${talk}`);
  if (risk) aiReplyParts.push(`安全提醒：${risk}`);

  return {
    問題: title,
    類型: type,
    主題: topic,
    身體區域: bodyArea,
    教材版回覆: material,
    教材重點: material,
    對應脊椎分節: segment,
    臨床流程建議: flow || process,
    判斷流程: process,
    客戶溝通話術: talk,
    經絡與補充: meridian || talk,
    禁忌標記: contraindication,
    風險提醒: risk,
    AI教學說法: aiTeach,
    AI回覆: aiReplyParts.join("\n") || "此為教學用途，非醫療診斷。身體不適請優先就醫。",
    version,
    updated_at: page.last_edited_time,
    id: page.id
  };
}

// ---------- 命中排序 ----------
function scorePage(page, intent, text, keywords) {
  const title = getTextFromPage(page, "問題");
  const type = getTextFromPage(page, "類型");
  const topic = getTextFromPage(page, "主題");
  const keyText = getTextFromPage(page, "關鍵字");
  const segment = getTextFromPage(page, "對應脊椎分節");
  const material = getTextFromPage(page, "教材版回覆");
  const aiTeach = getTextFromPage(page, "AI教學說法");
  const process = getTextFromPage(page, "判斷流程");
  const talk = getTextFromPage(page, "客戶溝通話術");

  const all = `${title} ${type} ${topic} ${keyText} ${segment} ${material} ${aiTeach} ${process} ${talk}`;

  let score = 0;

  if (type === intent) score += 80;

  for (const k of keywords) {
    if (!k) continue;
    if (title.includes(k)) score += 70;
    if (keyText.includes(k)) score += 60;
    if (topic.includes(k)) score += 35;
    if (segment.includes(k)) score += 35;
    if (material.includes(k)) score += 20;
    if (aiTeach.includes(k)) score += 20;
    if (process.includes(k)) score += 20;
    if (talk.includes(k)) score += 15;
    if (all.includes(k)) score += 10;
  }

  if (text && title && text.includes(title)) score += 60;
  if (title && text && title.includes(text)) score += 50;

  // PD 類優先
  if (/PD|pd|長短腳|腳長|怎麼判斷|判斷流程|骨盆下沉|姿勢偏差/.test(text)) {
    if (/PD|長短腳|腳檢測|骨盆下沉|姿勢偏差|判斷/.test(title)) score += 120;
    if (type === "判斷流程") score += 100;
    if (topic.includes("PD")) score += 80;
    if (keyText.includes("PD")) score += 80;
  }

  // QA 問法優先
  if (/為什麼|怎麼|多久|不打痛點|打一邊|會痠|好痠|第一次/.test(text)) {
    if (type === "QA教學") score += 90;
    if (/不打痛點|打一邊|痠|多久|第一次/.test(title)) score += 100;
  }

  // 禁忌優先
  if (/骨折|腫瘤|癌|急性|發炎|感染|骨鬆|骨質疏鬆|打釘|開刀/.test(text)) {
    if (type === "禁忌風險") score += 150;
    if (/骨折|腫瘤|禁忌|風險|不能|不適宜/.test(title)) score += 120;
  }

  // 分節查詢優先
  if (/\b(C[1-7]|T[1-9]|T1[0-2]|L[1-5])\b/.test(text)) {
    if (type === "症狀對應" || type === "分節對應") score += 80;
    if (segment && text.includes(segment)) score += 100;
  }

  return score;
}

// ---------- Notion 查詢 ----------
async function queryByTitle(text, limit = 10) {
  const key = clean(text).slice(0, 30);
  if (!key) return [];

  try {
    const r = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        and: [
          { property: "是否啟用", checkbox: { equals: true } },
          { property: "問題", title: { contains: key } }
        ]
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: limit
    });

    return r.results || [];
  } catch (e) {
    console.error("[queryByTitle]", e?.message || e);
    return [];
  }
}

async function queryByType(intent, limit = 20) {
  if (!intent) return [];

  try {
    const r = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        and: [
          { property: "是否啟用", checkbox: { equals: true } },
          { property: "類型", select: { equals: intent } }
        ]
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: limit
    });

    return r.results || [];
  } catch (e) {
    console.error("[queryByType]", e?.message || e);
    return [];
  }
}

async function queryByKeyword(keyword, limit = 20) {
  if (!keyword) return [];

  try {
    const r = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        and: [
          { property: "是否啟用", checkbox: { equals: true } },
          { property: "關鍵字", multi_select: { contains: keyword } }
        ]
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: limit
    });

    return r.results || [];
  } catch (e) {
    console.error("[queryByKeyword]", keyword, e?.message || e);
    return [];
  }
}

async function queryBySegment(segment, limit = 20) {
  if (!segment) return [];

  try {
    const r = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        and: [
          { property: "是否啟用", checkbox: { equals: true } },
          { property: "對應脊椎分節", rich_text: { contains: segment } }
        ]
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: limit
    });

    if (r.results?.length) return r.results;
  } catch (e) {}

  try {
    const r2 = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        and: [
          { property: "是否啟用", checkbox: { equals: true } },
          { property: "對應脊椎分節", multi_select: { contains: segment } }
        ]
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: limit
    });

    return r2.results || [];
  } catch (e) {
    return [];
  }
}

function uniquePages(pages) {
  const map = new Map();
  for (const p of pages || []) {
    if (p?.id && !map.has(p.id)) map.set(p.id, p);
  }
  return [...map.values()];
}

async function searchKnowledgeBase(intent, text, keywords) {
  let results = [];

  // 1. 完整標題查詢
  results.push(...await queryByTitle(text, 10));

  // 2. 關鍵字查詢
  for (const k of keywords) {
    results.push(...await queryByKeyword(k, 20));
  }

  // 3. 分節查詢
  const seg = keywords.find(k => /^(C[1-7]|T[1-9]|T1[0-2]|L[1-5]|薦椎|尾椎|骨盆)$/.test(k));
  if (seg) {
    results.push(...await queryBySegment(seg, 20));
  }

  // 4. 類型查詢
  results.push(...await queryByType(intent, 20));

  // 5. 若完全沒有，補核心觀念
  results = uniquePages(results);

  if (!results.length) {
    results.push(...await queryByType("核心觀念", 10));
  }

  return uniquePages(results);
}

// ---------- 主 API ----------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res.status(500).json({
        error: "Missing NOTION_TOKEN or NOTION_DB_ID"
      });
    }

    const { email = "", question, 問題, q } = req.body || {};
    const userQuestion = clean(question ?? 問題 ?? q ?? "");

    if (!isEmail(email)) {
      return res.status(400).json({
        error: "請輸入有效 Email 才能使用。"
      });
    }

    const gate = await checkMember(email);
    if (!gate.ok) {
      const msg =
        gate.reason === "not_found" ? "此 Email 不在會員名單中。"
      : gate.reason === "disabled" ? "帳號已停用，如需啟用請聯繫我們。"
      : gate.reason === "expired" ? "您的會員已到期，請續約後再使用。"
      : "目前無法驗證您的資格。";

      return res.status(403).json({
        error: JOIN_URL ? `${msg} 申請/續約：${JOIN_URL}` : msg
      });
    }

    if (!userQuestion) {
      return res.status(400).json({
        error: "請輸入問題或關鍵字。"
      });
    }

    const intent = detectIntent(userQuestion);
    const keywords = extractKeywords(userQuestion);
    const matchedKeyword = keywords[0] || userQuestion;

    let pages = await searchKnowledgeBase(intent, userQuestion, keywords);

    pages = (pages || []).sort((a, b) => {
      const sa = scorePage(a, intent, userQuestion, keywords);
      const sb = scorePage(b, intent, userQuestion, keywords);
      return sb - sa;
    });

    const items = pages.slice(0, 5).map(page => pageToItemForLine(page, intent));

    if (!items.length) {
      return res.json({
        mode: "Router查詢",
        email,
        intent,
        matched: matchedKeyword,
        count: 0,
        items: [],
        answer: null,
        version: "router-v2",
        updated_at: null,
        message: "查不到相符條目，請改用其他關鍵字，例如：C1、PD、手麻、為什麼不打痛點。"
      });
    }

    return res.json({
      mode: "Router查詢",
      email,
      intent,
      matched: matchedKeyword,
      count: items.length,
      items,
      answer: items[0],
      version: items[0]?.version || "router-v2",
      updated_at: items[0]?.updated_at || null
    });

  } catch (err) {
    console.error("[answer_router_error]", err);
    return res.status(500).json({
      error: String(err?.message || err)
    });
  }
};
