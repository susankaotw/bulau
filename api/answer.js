// api/answer.js
// 不老 AI Router 查詢版 V4
// 重點：AI 意圖判斷優先、規則 fallback、查詢標準化、強排序、去重、LINE items 格式

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_ID = process.env.NOTION_DB_ID;
const MEMBER_DB = process.env.NOTION_MEMBER_DB_ID;
const JOIN_URL = process.env.JOIN_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const clean = (s) => String(s || "").trim();

function taipeiTodayYMD() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function extractExpireDateYMD(p) {
  const d = p["有效日期"]?.date || p["有效期限"]?.date;
  if (!d) return null;
  return String(d.end || d.start || "").slice(0, 10);
}

/* ===== 會員檢核 ===== */
async function checkMember(email) {
  if (!MEMBER_DB) return { ok: true };

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
  const statusName = p["狀態"]?.status?.name || p["狀態"]?.select?.name || "";

  if (["停用", "封鎖", "黑名單", "禁用", "已過期"].includes(statusName)) {
    return { ok: false, reason: "disabled" };
  }

  if (statusName && statusName !== "啟用" && statusName !== "測試") {
    return { ok: false, reason: "disabled" };
  }

  const expireYMD = extractExpireDateYMD(p);
  if (expireYMD && expireYMD < taipeiTodayYMD()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true };
}

/* ===== 規則 fallback ===== */
function detectIntentByRule(text) {
  const t = clean(text);

  if (/骨折|腫瘤|癌|急性|發炎|感染|骨鬆|骨質疏鬆|打釘|開刀|凝血|類風濕|嚴重|可以做嗎|能做嗎|能不能做|適合嗎/.test(t)) {
    return "禁忌風險";
  }

  if (/PD|pd|長短腳|腳長|左PD|右PD|姿勢偏差|骨盆下沉|怎麼判斷|判斷流程|問診|評估/.test(t)) {
    return "判斷流程";
  }

  if (/\b(C[1-7]|T[1-9]|T1[0-2]|L[1-5])\b|薦椎|尾椎|骨盆/.test(t)) {
    return "分節查詢";
  }

  if (/為什麼不打痛點|不打痛點|沒打到痛點|打一邊|為什麼打一邊|多久|一次多久|會痠|好痠|第一次比較久|筋膜槍|活化槍|專業型筋膜槍/.test(t)) {
    return "QA教學";
  }

  if (/痛|痠|酸|麻|卡|緊|無力|頭暈|頭痛|耳鳴|失眠|肩|頸|腰|背|腳|手|膝|足底|坐骨神經/.test(t)) {
    return "症狀對應";
  }

  if (/什麼是|甚麼是|原理|差異|半脫位|神經|脊椎|筋膜|修復|自我修復|結構平衡/.test(t)) {
    return "核心觀念";
  }

  return "教材查詢";
}

function extractKeywordsByRule(text) {
  const t = clean(text);
  const keywords = [];

  const patterns = [
    "半脫位", "什麼是半脫位", "甚麼是半脫位", "半脫位是什麼", "半脫位是甚麼",
    "動態半脫位", "靜態半脫位", "神經干擾", "神經", "脊椎", "筋膜", "修復機制", "自我修復",
    "PD", "PD怎麼判斷", "PD判斷", "PD檢測", "PD腳", "腳檢測", "長短腳", "姿勢偏差", "骨盆下沉", "問診", "評估",
    "為什麼不打痛點", "不打痛點", "沒打到痛點", "痛點", "打一邊", "為什麼打一邊", "剛打完覺得好痠", "會痠", "好痠", "多久打一次", "第一次比較久",
    "頭痛", "頭暈", "耳鳴", "失眠", "落枕", "肩痛", "肩頸", "手麻", "腰痛", "背痛", "膝蓋痛", "坐骨神經", "足底筋膜", "腳跟痛",
    "骨折", "腫瘤", "急性發炎", "發炎", "骨質疏鬆", "骨鬆", "感染", "打釘", "開刀",
    "筋膜槍", "活化槍", "專業型筋膜槍",
    "C1", "C2", "C3", "C4", "C5", "C6", "C7",
    "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12",
    "L1", "L2", "L3", "L4", "L5",
    "薦椎", "尾椎", "骨盆"
  ];

  for (const p of patterns) {
    if (t.includes(p)) keywords.push(p);
  }

  const segs = t.match(/\b(C[1-7]|T[1-9]|T1[0-2]|L[1-5])\b/g);
  if (segs) keywords.push(...segs);

  return [...new Set(keywords.filter(Boolean))];
}

/* ===== AI Normalizer ===== */
async function getOpenAIClient() {
  if (!OPENAI_API_KEY) return null;
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

async function normalizeQuestionWithAI(rawQuestion) {
  const ruleIntent = detectIntentByRule(rawQuestion);
  const ruleKeywords = extractKeywordsByRule(rawQuestion);

  if (!OPENAI_API_KEY) {
    return {
      normalized_question: ruleCanonicalQuestion(rawQuestion),
      intent: ruleIntent,
      keywords: [...new Set([...ruleKeywords, rawQuestion, ruleCanonicalQuestion(rawQuestion)].filter(Boolean))],
      confidence: 0.5,
      source: "rule"
    };
  }

  try {
    const client = await getOpenAIClient();

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
你是不老骨架平衡中心的「教材查詢意圖整理器」。
你的任務不是回答問題，而是把學員輸入整理成適合查 Notion 教材庫的 JSON。

只輸出 JSON，不要輸出解釋。

可用 intent：
- 核心觀念
- 症狀對應
- 分節查詢
- 判斷流程
- QA教學
- 禁忌風險
- 技術操作
- 教材查詢

重要規則：
1. 如果使用者只輸入「半脫位」，視為「什麼是半脫位」。
2. 「半脫位」「什麼是半脫位」「甚麼是半脫位」「半脫位是什麼」「半脫位是甚麼」都視為「什麼是半脫位」，intent = 核心觀念。
3. 「PD」「PD怎麼判斷」「PD判斷」「PD腳」「長短腳」「骨盆下沉」「姿勢偏差」intent = 判斷流程。
4. 「C1」「C2」「T6」「L5」等分節，intent = 分節查詢。
5. 「手麻」「腰痛」「肩痛」「足底筋膜」「坐骨神經」intent = 症狀對應。
6. 「為什麼不打痛點」「為什麼打一邊」「多久打一次」「打完好痠」intent = QA教學。
7. 「骨折」「腫瘤」「急性發炎」「骨質疏鬆」「感染」「開刀」「打釘」intent = 禁忌風險。
8. normalized_question 要是教材庫裡可能存在的標準問題。
9. keywords 必須包含：
   - 原始輸入
   - 標準問題
   - 至少 2 個教材關鍵詞
10. confidence 是 0 到 1。

輸出格式：
{
  "normalized_question": "什麼是半脫位",
  "intent": "核心觀念",
  "keywords": ["半脫位", "什麼是半脫位", "神經干擾", "動態半脫位"],
  "confidence": 0.95
}
`
        },
        { role: "user", content: rawQuestion }
      ]
    });

    const parsed = JSON.parse(completion?.choices?.[0]?.message?.content || "{}");

    const normalizedQuestion = clean(parsed.normalized_question || ruleCanonicalQuestion(rawQuestion) || rawQuestion);
    const intent = clean(parsed.intent || ruleIntent);
    const aiKeywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(clean).filter(Boolean) : [];

    return {
      normalized_question: normalizedQuestion,
      intent,
      keywords: [...new Set([...aiKeywords, ...ruleKeywords, rawQuestion, normalizedQuestion].filter(Boolean))],
      confidence: Number(parsed.confidence || 0.7),
      source: "ai"
    };

  } catch (e) {
    console.error("[AI_NORMALIZER_FALLBACK]", e?.message || e);
    const canonical = ruleCanonicalQuestion(rawQuestion);

    return {
      normalized_question: canonical || rawQuestion,
      intent: ruleIntent,
      keywords: [...new Set([...ruleKeywords, rawQuestion, canonical].filter(Boolean))],
      confidence: 0.5,
      source: "rule_fallback"
    };
  }
}

function ruleCanonicalQuestion(text) {
  const t = clean(text);

  if (/^半脫位$|什麼是半脫位|甚麼是半脫位|半脫位是什麼|半脫位是甚麼/.test(t)) {
    return "什麼是半脫位";
  }

  if (/^PD$|PD怎麼判斷|PD判斷|PD檢測|PD腳|長短腳/.test(t)) {
    return "PD檢測是什麼";
  }

  if (/為什麼不打痛點|不打痛點|沒打到痛點|沒打痛點/.test(t)) {
    return "為什麼不打痛點";
  }

  if (/為什麼打一邊|打一邊|只打一邊|單邊調整/.test(t)) {
    return "為什麼打一邊";
  }

  return t;
}

/* ===== Notion 欄位讀取 ===== */
function getTextFromPage(page, key) {
  const prop = page?.properties?.[key];
  if (!prop) return "";

  if (prop.type === "title") return prop.title?.map(t => t.plain_text).join("").trim() || "";
  if (prop.type === "rich_text") return prop.rich_text?.map(t => t.plain_text).join("").trim() || "";
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "multi_select") return prop.multi_select?.map(x => x.name).join("、") || "";
  if (prop.type === "checkbox") return prop.checkbox ? "是" : "否";
  if (prop.type === "date") return prop.date?.start || "";

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
  const version = getTextFromPage(page, "版本號") || "router-v4";

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

/* ===== 命中排序 ===== */
function scorePage(page, intent, rawText, normalizedText, keywords) {
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

  if (type === intent) score += 120;

  if (normalizedText && title === normalizedText) score += 350;
  if (normalizedText && title.includes(normalizedText)) score += 180;
  if (normalizedText && normalizedText.includes(title)) score += 120;

  for (const k of keywords) {
    if (!k) continue;
    if (title === k) score += 180;
    if (title.includes(k)) score += 120;
    if (keyText.includes(k)) score += 100;
    if (topic.includes(k)) score += 50;
    if (segment.includes(k)) score += 50;
    if (material.includes(k)) score += 30;
    if (aiTeach.includes(k)) score += 30;
    if (process.includes(k)) score += 25;
    if (talk.includes(k)) score += 20;
    if (all.includes(k)) score += 10;
  }

  if (/半脫位/.test(rawText)) {
    if (title === "什麼是半脫位") score += 500;
    if (title.includes("半脫位")) score += 180;
    if (type === "核心觀念") score += 120;
  }

  if (/PD|pd|長短腳|腳長|怎麼判斷|判斷流程|骨盆下沉|姿勢偏差/.test(rawText)) {
    if (/PD|長短腳|腳檢測|骨盆下沉|姿勢偏差|判斷/.test(title)) score += 220;
    if (type === "判斷流程") score += 160;
    if (topic.includes("PD")) score += 120;
    if (keyText.includes("PD")) score += 120;
  }

  if (/為什麼|怎麼|多久|不打痛點|打一邊|會痠|好痠|第一次/.test(rawText)) {
    if (type === "QA教學") score += 130;
    if (/不打痛點|打一邊|痠|多久|第一次/.test(title)) score += 160;
  }

  if (/骨折|腫瘤|癌|急性|發炎|感染|骨鬆|骨質疏鬆|打釘|開刀/.test(rawText)) {
    if (type === "禁忌風險") score += 220;
    if (/骨折|腫瘤|禁忌|風險|不能|不適宜/.test(title)) score += 180;
  }

  if (/\b(C[1-7]|T[1-9]|T1[0-2]|L[1-5])\b/.test(rawText)) {
    if (type === "症狀對應" || type === "分節對應" || intent === "分節查詢") score += 120;
  }

  return score;
}

/* ===== Notion 查詢 ===== */
async function queryByTitle(text, limit = 10) {
  const key = clean(text).slice(0, 50);
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

async function searchKnowledgeBase({ intent, rawQuestion, normalizedQuestion, keywords }) {
  let results = [];

  results.push(...await queryByTitle(normalizedQuestion, 10));
  results.push(...await queryByTitle(rawQuestion, 10));

  for (const k of keywords) {
    results.push(...await queryByKeyword(k, 20));
  }

  const seg = keywords.find(k => /^(C[1-7]|T[1-9]|T1[0-2]|L[1-5]|薦椎|尾椎|骨盆)$/.test(k));
  if (seg) results.push(...await queryBySegment(seg, 20));

  results.push(...await queryByType(intent, 20));

  results = uniquePages(results);

  if (!results.length) {
    results.push(...await queryByType("核心觀念", 10));
  }

  return uniquePages(results);
}

/* ===== 主 API ===== */
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    if (!process.env.NOTION_TOKEN || !DB_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }

    const { email = "", question, 問題, q } = req.body || {};
    const rawQuestion = clean(question ?? 問題 ?? q ?? "");

    if (!isEmail(email)) {
      return res.status(400).json({ error: "請輸入有效 Email 才能使用。" });
    }

    const gate = await checkMember(email);
    if (!gate.ok) {
      const msg =
        gate.reason === "not_found" ? "此 Email 不在會員名單中。"
      : gate.reason === "disabled" ? "帳號已停用，如需啟用請聯繫我們。"
      : gate.reason === "expired" ? "您的會員已到期，請續約後再使用。"
      : "目前無法驗證您的資格。";

      return res.status(403).json({ error: JOIN_URL ? `${msg} 申請/續約：${JOIN_URL}` : msg });
    }

    if (!rawQuestion) {
      return res.status(400).json({ error: "請輸入問題或關鍵字。" });
    }

    const normalized = await normalizeQuestionWithAI(rawQuestion);

    const intent = normalized.source === "ai"
      ? normalized.intent
      : detectIntentByRule(rawQuestion);

    const normalizedQuestion = normalized.normalized_question || rawQuestion;

    const keywords = Array.isArray(normalized.keywords) && normalized.keywords.length
      ? normalized.keywords
      : extractKeywordsByRule(rawQuestion);

    const matchedKeyword = keywords[0] || normalizedQuestion || rawQuestion;

    let pages = await searchKnowledgeBase({
      intent,
      rawQuestion,
      normalizedQuestion,
      keywords
    });

    pages = (pages || []).sort((a, b) => {
      const sa = scorePage(a, intent, rawQuestion, normalizedQuestion, keywords);
      const sb = scorePage(b, intent, rawQuestion, normalizedQuestion, keywords);
      return sb - sa;
    });

    const items = pages.slice(0, 5).map(page => pageToItemForLine(page, intent));

    if (!items.length) {
      return res.json({
        mode: "Router查詢",
        email,
        intent,
        normalized_question: normalizedQuestion,
        normalizer_source: normalized.source,
        normalizer_confidence: normalized.confidence,
        matched: matchedKeyword,
        count: 0,
        items: [],
        answer: null,
        version: "router-v4",
        updated_at: null,
        message: "查不到相符條目，請改用其他關鍵字，例如：C1、PD、手麻、為什麼不打痛點。"
      });
    }

    return res.json({
      mode: "Router查詢",
      email,
      intent,
      normalized_question: normalizedQuestion,
      normalizer_source: normalized.source,
      normalizer_confidence: normalized.confidence,
      matched: matchedKeyword,
      count: items.length,
      items,
      answer: items[0],
      version: items[0]?.version || "router-v4",
      updated_at: items[0]?.updated_at || null
    });

  } catch (err) {
    console.error("[answer_router_v4_error]", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
