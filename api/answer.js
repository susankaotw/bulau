// api/answer.js
// V6.1.1 穩定版：資料庫主資料優先 + AI補充分層 + Notion查詢穩定化 + AI自評欄位
// 需要檔案：
// /prompts/knowledge-query.md
// /prompts/knowledge-answer.md

const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const QA_DB_ID = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || "";
const NOTION_VER = "2022-06-28";

/* =========================
   Notion QA DB 欄位
========================= */

const QA_QUESTION = "問題";
const QA_TOPIC = "主題";
const QA_SEGMENT = "對應脊椎分節";
const QA_REPLY = "教材版回覆";
const QA_FLOW = "臨床流程建議";
const QA_MERIDIAN = "經絡與補充";
const QA_ENABLED = "是否啟用";

const QA_AI_TEACHING = "AI教學說法";
const QA_JUDGEMENT_FLOW = "判斷流程";
const QA_CUSTOMER_SCRIPT = "客戶溝通話術";
const QA_RISK_NOTICE = "風險提醒";
const QA_CONTRAINDICATION = "禁忌標記";
const QA_KEYWORDS = "關鍵字";
const QA_TYPE = "類型";
const QA_BODY_AREA = "身體區域";
const QA_AUDIENCE = "適用對象";

/* =========================
   API 入口
========================= */

module.exports = async function handler(req, res) {
  try {

     // ✅ CORS 設定（關鍵）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // ✅ 處理 preflight（非常重要）
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

      // ✅ 測試 API 是否活著
     if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        name: "Bulau AI Answer API",
        version: "V6.1.1-stable-knowledge-first",
        message: "answer.js is running"
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    const body = req.body || {};
    const userMessage = normalizeText(
      body.message || body.q || body.question || body.text || ""
    );

    const requestMode = normalizeText(body.mode || body.answer_mode || "");

    if (!userMessage) {
      return res.status(400).json({
        ok: false,
        error: "Missing message"
      });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing OPENAI_API_KEY"
      });
    }

    if (!NOTION_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing NOTION_API_KEY or NOTION_TOKEN"
      });
    }

    if (!QA_DB_ID) {
      return res.status(500).json({
        ok: false,
        error: "Missing NOTION_QA_DB_ID or NOTION_DB_ID"
      });
    }

    const queryInfo = await analyzeQueryByMd(userMessage);

    if (requestMode === "expand") {
      queryInfo.answer_mode = "AI延伸補充";
    }

    const knowledgeItems = await queryNotionKnowledge(queryInfo, userMessage);

    const primaryKnowledgeItem = findPrimaryKnowledgeItem({
      userMessage,
      queryInfo,
      knowledgeItems
    });

    const answerSource = decideAnswerSource({
      requestMode,
      queryInfo,
      knowledgeItems,
      primaryKnowledgeItem
    });

    const finalReply = await generateFinalAnswer({
      userMessage,
      queryInfo,
      answerSource,
      primaryKnowledgeItem,
      knowledgeItems
    });

    const debugMeta = buildDebugMeta({
      queryInfo,
      answerSource,
      knowledgeItems,
      primaryKnowledgeItem
    });

    return res.status(200).json({
      ok: true,
      reply: finalReply,
      debug: debugMeta
    });
  } catch (error) {
    console.error("[answer_error]", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Internal server error"
    });
  }
};

/* =========================
   讀取 Prompt
========================= */

function readPrompt(filename) {
  const filePath = path.join(process.cwd(), "prompts", filename);

  if (!fs.existsSync(filePath)) {
    throw new Error("Prompt file not found: " + filePath);
  }

  return fs.readFileSync(filePath, "utf8");
}

/* =========================
   AI：查詢理解層
========================= */

async function analyzeQueryByMd(userMessage) {
  const prompt = readPrompt("knowledge-query.md");

  console.log("[QUERY_PROMPT_VERSION]", prompt.slice(0, 100));

  const content = await callOpenAI({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userMessage }
    ],
    temperature: 0.1,
    responseFormatJson: true
  });

  const parsed = safeJsonParse(content);

  if (!parsed) {
    return {
      normalized_question: userMessage,
      need_knowledge_base: true,
      query_keywords: [userMessage],
      answer_mode: "無法判斷",
      audience: "student",
      only_enabled: true,
      safety_level: "normal"
    };
  }

  const rawKeywords = Array.isArray(parsed.query_keywords)
    ? parsed.query_keywords
    : [];

  const keywords = uniqueStrings([
    userMessage,
    parsed.normalized_question || ""
  ].concat(rawKeywords));

  return {
    normalized_question: normalizeText(parsed.normalized_question || userMessage),
    need_knowledge_base: parsed.need_knowledge_base !== false,
    query_keywords: keywords.slice(0, 6),
    answer_mode: parsed.answer_mode || "無法判斷",
    audience: parsed.audience || "student",
    only_enabled: parsed.only_enabled !== false,
    safety_level: parsed.safety_level || "normal"
  };
}

/* =========================
   Notion 知識庫查詢
========================= */

async function queryNotionKnowledge(queryInfo, userMessage) {
  if (!queryInfo || queryInfo.need_knowledge_base === false) return [];

  const keywords = uniqueStrings([
    userMessage,
    queryInfo.normalized_question
  ].concat(queryInfo.query_keywords || []))
    .map(function (x) {
      return normalizeText(x);
    })
    .filter(Boolean)
    .slice(0, 3);

  const resultMap = {};

  for (const keyword of keywords) {
    const filters = buildSafeKeywordFilters(keyword);

    for (const filter of filters) {
      try {
        const data = await notionQueryDatabase(QA_DB_ID, {
          filter,
          page_size: 5,
          sorts: [
            {
              timestamp: "last_edited_time",
              direction: "descending"
            }
          ]
        });

        const pages = Array.isArray(data.results) ? data.results : [];

        for (const page of pages) {
          if (!isPageEnabled(page)) continue;
          resultMap[page.id] = page;
        }
      } catch (err) {
        console.error("[notion_query_error]", {
          keyword,
          message: err.message || String(err)
        });
      }
    }
  }

  const pages = Object.keys(resultMap).map(function (id) {
    return resultMap[id];
  });

  const items = pages
    .map(pageToKnowledgeItem)
    .filter(function (item) {
      return item.question ||
        item.teachingAnswer ||
        item.clinicalSuggestion ||
        item.judgementFlow ||
        item.aiTeaching ||
        item.customerScript ||
        item.meridian;
    });

  return sortKnowledgeItems({
    userMessage,
    queryInfo,
    items
  }).slice(0, 8);
}

function buildSafeKeywordFilters(keyword) {
  const filters = [];

  const baseEnabled = {
    property: QA_ENABLED,
    checkbox: {
      equals: true
    }
  };

  filters.push({
    and: [
      baseEnabled,
      {
        property: QA_QUESTION,
        title: {
          contains: keyword
        }
      }
    ]
  });

  const richTextFields = [
    QA_REPLY,
    QA_JUDGEMENT_FLOW,
    QA_CUSTOMER_SCRIPT,
    QA_AI_TEACHING
  ];

  for (const field of richTextFields) {
    filters.push({
      and: [
        baseEnabled,
        {
          property: field,
          rich_text: {
            contains: keyword
          }
        }
      ]
    });
  }

  return filters;
}

function isPageEnabled(page) {
  const props = page && page.properties ? page.properties : {};
  const enabledProp = props[QA_ENABLED];

  if (!enabledProp) return false;

  if (enabledProp.type === "checkbox") {
    return enabledProp.checkbox === true;
  }

  if (enabledProp.type === "select") {
    const name = enabledProp.select ? enabledProp.select.name : "";
    return ["啟用", "使用", "是", "YES", "true"].indexOf(name) >= 0;
  }

  if (enabledProp.type === "status") {
    const name = enabledProp.status ? enabledProp.status.name : "";
    return ["啟用", "使用", "是", "YES", "true"].indexOf(name) >= 0;
  }

  return false;
}

function pageToKnowledgeItem(page) {
  const p = page && page.properties ? page.properties : {};

  return {
    id: page.id,
    question: readTitleOrRichText(p[QA_QUESTION]),
    topic: readSelect(p[QA_TOPIC]),
    type: readSelect(p[QA_TYPE]),
    spine: readRichText(p[QA_SEGMENT]),
    teachingAnswer: readRichText(p[QA_REPLY]),
    clinicalSuggestion: readRichText(p[QA_FLOW]),
    meridian: readRichText(p[QA_MERIDIAN]),
    aiTeaching: readRichText(p[QA_AI_TEACHING]),
    judgementFlow: readRichText(p[QA_JUDGEMENT_FLOW]),
    customerScript: readRichText(p[QA_CUSTOMER_SCRIPT]),
    riskNotice: readRichText(p[QA_RISK_NOTICE]),
    contraindication: readSelectOrMultiSelect(p[QA_CONTRAINDICATION]),
    keywords: readSelectOrMultiSelect(p[QA_KEYWORDS]),
    bodyArea: readSelect(p[QA_BODY_AREA]),
    audience: readSelect(p[QA_AUDIENCE]),
    _score: 0
  };
}

/* =========================
   主資料優先排序
========================= */

function sortKnowledgeItems({ userMessage, queryInfo, items }) {
  const scored = (items || []).map(function (item) {
    const score = scoreKnowledgeItem({
      userMessage,
      queryInfo,
      item
    });

    return Object.assign({}, item, {
      _score: score
    });
  });

  return scored.sort(function (a, b) {
    return b._score - a._score;
  });
}

function findPrimaryKnowledgeItem({ userMessage, queryInfo, knowledgeItems }) {
  if (!knowledgeItems || !knowledgeItems.length) return null;

  const sorted = sortKnowledgeItems({
    userMessage,
    queryInfo,
    items: knowledgeItems
  });

  return sorted[0] || null;
}

function scoreKnowledgeItem({ userMessage, queryInfo, item }) {
  const raw = normalizeForCompare(userMessage);
  const normalized = normalizeForCompare(queryInfo.normalized_question || "");
  const keywords = (queryInfo.query_keywords || []).map(normalizeForCompare).filter(Boolean);

  const question = normalizeForCompare(item.question || "");
  const topic = normalizeForCompare(item.topic || "");
  const type = normalizeForCompare(item.type || "");
  const itemKeywords = normalizeForCompare(item.keywords || "");
  const allText = normalizeForCompare([
    item.question,
    item.topic,
    item.type,
    item.spine,
    item.teachingAnswer,
    item.clinicalSuggestion,
    item.meridian,
    item.aiTeaching,
    item.judgementFlow,
    item.customerScript,
    item.riskNotice,
    item.contraindication,
    item.keywords,
    item.bodyArea
  ].join(" "));

  let score = 0;

  if (question && raw && question === raw) score += 220;
  if (question && normalized && question === normalized) score += 180;

  if (question && raw && question.includes(raw)) score += 160;
  if (raw && question && raw.includes(question)) score += 130;

  if (question && normalized && question.includes(normalized)) score += 100;
  if (normalized && question && normalized.includes(question)) score += 80;

  for (const kw of keywords) {
    if (!kw) continue;

    if (question && question === kw) score += 90;
    if (question && question.includes(kw)) score += 60;
    if (kw.includes(question) && question.length >= 2) score += 45;

    if (itemKeywords && itemKeywords.includes(kw)) score += 30;
    if (topic && topic.includes(kw)) score += 18;
    if (type && type.includes(kw)) score += 12;
    if (allText && allText.includes(kw)) score += 8;
  }

  if (item.teachingAnswer) score += 8;
  if (item.judgementFlow) score += 12;
  if (item.clinicalSuggestion) score += 8;
  if (item.customerScript) score += 10;
  if (item.aiTeaching) score += 8;
  if (item.riskNotice) score += 4;

  if (question.length <= 2 && raw.length >= 4) score -= 30;

  return score;
}

function normalizeForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。．.、：:；;！!？?\-—_()[\]{}「」『』]/g, "")
    .trim();
}

/* =========================
   回答來源判斷
========================= */

function decideAnswerSource({ requestMode, queryInfo, knowledgeItems, primaryKnowledgeItem }) {
  if (requestMode === "expand" || queryInfo.answer_mode === "AI延伸補充") {
    return "ai_expand";
  }

  if (primaryKnowledgeItem && knowledgeItems && knowledgeItems.length > 0) {
    return "knowledge_first";
  }

  return "ai_fallback";
}

/* =========================
   產生最終回答
========================= */

async function generateFinalAnswer({
  userMessage,
  queryInfo,
  answerSource,
  primaryKnowledgeItem,
  knowledgeItems
}) {
  const basePrompt = safeReadPrompt("knowledge-answer.md");

  let systemPrompt = "";

  if (answerSource === "knowledge_first") {
    systemPrompt = [
      basePrompt,
      "",
      "--------------------------------------------------",
      "【V6.1.1 穩定版：資料庫主資料優先】",
      "",
      "系統已經找到主命中資料。",
      "請以主命中資料作為回答主體。",
      "",
      "強制規則：",
      "1. 一定先呈現主命中資料，不可以先講一般知識。",
      "2. 不可以把多筆資料混成泛泛說明。",
      "3. 其他命中資料只能作為補充，不可蓋過主資料。",
      "4. AI只負責整理語氣、補安全說法，不可以改掉教材核心意思。",
      "5. 若欄位空白，可以略過，不要硬補。",
      "6. 若要補充，請放在【AI補充說明】。",
      "7. 如果使用者問操作、怎麼打、怎麼判斷，必須加入安全提醒。",
      "8. 不要提到資料庫、主命中資料、系統內部、debug。",
      "",
      "請使用以下輸出結構：",
      "",
      "【教材重點】",
      "整理教材版回覆與AI教學說法。",
      "",
      "【判斷流程】",
      "整理判斷流程與臨床流程建議。",
      "",
      "【對客說法】",
      "整理客戶溝通話術。",
      "",
      "【AI補充說明】",
      "只能做保守補充，不可宣稱治療，不可診斷。",
      "",
      "【學員溝通提醒】",
      "提醒避免醫療診斷、療效承諾、因果說法。",
      "",
      "回答請適合 LINE 閱讀，不要過長。"
    ].join("\n");
  } else if (answerSource === "ai_expand") {
    systemPrompt = [
      "你是不老AI助理，正在回應學員要求「多補充一點」。",
      "",
      "重要規則：",
      "1. 如果有知識庫資料，仍要以資料庫為基礎。",
      "2. 這一輪可以比一般回答多補充「結構 × 肌肉 × 神經」邏輯。",
      "3. 但必須明確保守，不可診斷、不可治療宣稱。",
      "4. 不要假裝資料庫有沒有寫的內容。",
      "5. 適合 LINE 閱讀，不要太長。",
      "",
      "輸出結構：",
      "【延伸理解】",
      "【結構 × 肌肉 × 神經補充】",
      "【觀察重點】",
      "【安全提醒】"
    ].join("\n");
  } else {
    systemPrompt = [
      "你是不老AI助理。",
      "目前系統沒有找到啟用中的教材資料。",
      "",
      "你必須明確告訴學員：",
      "「目前資料庫還沒有找到這題的完整教材，我先用不老的結構 × 神經 × 肌肉邏輯做安全補充。」",
      "",
      "回答規則：",
      "1. 不可假裝有資料庫內容。",
      "2. 不可做醫療診斷。",
      "3. 不可宣稱治療疾病。",
      "4. 可以做結構觀察、肌肉張力、神經訊號、代償方向的保守說明。",
      "5. 如果涉及疼痛、麻、無力、暈、胸悶、急性受傷，提醒先由合格醫療專業評估。",
      "6. 回答要適合 LINE 閱讀。",
      "",
      "輸出結構：",
      "【目前資料狀態】",
      "【AI安全補充】",
      "【觀察重點】",
      "【學員溝通提醒】"
    ].join("\n");
  }

  const userPrompt = [
    "使用者原始問題：",
    userMessage,
    "",
    "查詢理解結果：",
    JSON.stringify(queryInfo, null, 2),
    "",
    "回答來源：",
    answerSource,
    "",
    "主命中資料：",
    primaryKnowledgeItem ? formatSingleKnowledgeForAI(primaryKnowledgeItem) : "無主命中資料",
    "",
    "其他命中資料：",
    formatKnowledgeForAI(
      (knowledgeItems || []).filter(function (x) {
        return !primaryKnowledgeItem || x.id !== primaryKnowledgeItem.id;
      }).slice(0, 4)
    ),
    "",
    "請產生給學員看的最終回答。"
  ].join("\n");

  const answer = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: answerSource === "ai_expand" ? 0.35 : 0.2,
    responseFormatJson: false
  });

  return String(answer || "").trim();
}

/* =========================
   Debug
========================= */

function buildDebugMeta({
  queryInfo,
  answerSource,
  knowledgeItems,
  primaryKnowledgeItem
}) {
  const hitKnowledge = !!(primaryKnowledgeItem && knowledgeItems && knowledgeItems.length > 0);
  const riskLevel = inferRiskLevel(queryInfo, primaryKnowledgeItem);

  const aiScore = calcAiScore({
    answerSource,
    knowledgeItems,
    primaryKnowledgeItem,
    queryInfo
  });

  const aiReason = calcAiReason({
    answerSource,
    knowledgeItems,
    primaryKnowledgeItem,
    queryInfo
  });

  return {
    version: "V6.1.1-stable-knowledge-first",
    answer_source: answerSource,
    normalized_question: queryInfo.normalized_question,
    query_keywords: queryInfo.query_keywords,
    answer_mode: queryInfo.answer_mode,
    audience: queryInfo.audience,
    knowledge_count: knowledgeItems.length,
    primary_title: primaryKnowledgeItem ? primaryKnowledgeItem.question : "",
    primary_score: primaryKnowledgeItem ? primaryKnowledgeItem._score : 0,
    matched_titles: knowledgeItems.map(function (x) {
      return x.question || "";
    }).filter(Boolean),
    ai_type: inferAiType(queryInfo),
    risk_level: riskLevel,
    hit_knowledge_base: hitKnowledge,
    need_human_update: !hitKnowledge,
    ai_score: aiScore,
    ai_reason: aiReason
  };
}

function calcAiScore({ answerSource, knowledgeItems, primaryKnowledgeItem, queryInfo }) {
  if (answerSource === "knowledge_first" && primaryKnowledgeItem) {
    if ((primaryKnowledgeItem.teachingAnswer || "") && (primaryKnowledgeItem.judgementFlow || "")) {
      return 90;
    }

    if ((primaryKnowledgeItem.teachingAnswer || "") || (primaryKnowledgeItem.judgementFlow || "")) {
      return 80;
    }

    return 70;
  }

  if (answerSource === "ai_expand") {
    return 75;
  }

  return 55;
}

function calcAiReason({ answerSource, knowledgeItems, primaryKnowledgeItem, queryInfo }) {
  if (answerSource === "knowledge_first" && primaryKnowledgeItem) {
    return `有命中正式教材「${primaryKnowledgeItem.question || "未命名教材"}」，回答以資料庫為主，AI僅做整理與安全補充。`;
  }

  if (answerSource === "ai_expand") {
    return "本次為AI延伸補充，建議人工確認補充內容是否符合不老教學邏輯與安全邊界。";
  }

  return "未命中正式教材，回答由AI依結構、神經、肌肉邏輯推論產生，建議人工檢查並考慮建立教材候選。";
}

function inferAiType(queryInfo) {
  const mode = queryInfo.answer_mode || "";

  if (mode === "禁忌風險") return "風險型";
  if (mode === "操作安全" || mode === "判斷流程") return "操作型";
  if (mode === "症狀狀況") return "症狀型";
  if (mode === "一般閒聊") return "閒聊型";

  return "知識型";
}

function inferRiskLevel(queryInfo, item) {
  const text = [
    queryInfo.normalized_question,
    queryInfo.answer_mode,
    (queryInfo.query_keywords || []).join(" "),
    item ? item.riskNotice : "",
    item ? item.contraindication : ""
  ].join(" ");

  if (/劇烈|麻|無力|頭暈|暈眩|胸悶|急性|骨折|腫瘤|感染|中風|發燒|失禁|外傷|惡化/.test(text)) {
    return "高";
  }

  if (/痛|疼痛|怎麼打|操作|判斷|風險|禁忌|觸法|不適/.test(text)) {
    return "注意";
  }

  return "無";
}

/* =========================
   知識庫格式化
========================= */

function formatSingleKnowledgeForAI(item) {
  if (!item) return "無";

  return [
    "問題：" + (item.question || "未填"),
    "主題：" + (item.topic || "未填"),
    "類型：" + (item.type || "未填"),
    "身體區域：" + (item.bodyArea || "未填"),
    "適用對象：" + (item.audience || "未填"),
    "關鍵字：" + (item.keywords || "未填"),
    "對應脊椎分節：" + (item.spine || "未填"),
    "教材版回覆：" + (item.teachingAnswer || "未填"),
    "AI教學說法：" + (item.aiTeaching || "未填"),
    "判斷流程：" + (item.judgementFlow || "未填"),
    "臨床流程建議：" + (item.clinicalSuggestion || "未填"),
    "客戶溝通話術：" + (item.customerScript || "未填"),
    "經絡與補充：" + (item.meridian || "未填"),
    "風險提醒：" + (item.riskNotice || "未填"),
    "禁忌標記：" + (item.contraindication || "未填")
  ].join("\n");
}

function formatKnowledgeForAI(items) {
  if (!items || !items.length) {
    return "目前沒有查到啟用中的知識庫資料。";
  }

  return items.map(function (item, index) {
    return [
      "【資料 " + (index + 1) + "】",
      formatSingleKnowledgeForAI(item)
    ].join("\n");
  }).join("\n\n");
}

/* =========================
   OpenAI
========================= */

async function callOpenAI(options) {
  const body = {
    model: "gpt-4o-mini",
    messages: options.messages,
    temperature: typeof options.temperature === "number" ? options.temperature : 0.2
  };

  if (options.responseFormatJson) {
    body.response_format = { type: "json_object" };
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await r.json();

  if (!r.ok) {
    console.error("[openai_error]", data);
    throw new Error(
      data && data.error && data.error.message
        ? data.error.message
        : "OpenAI API error"
    );
  }

  if (
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content
  ) {
    return data.choices[0].message.content;
  }

  return "";
}

/* =========================
   Notion API
========================= */

async function notionQueryDatabase(dbId, body) {
  const r = await fetch("https://api.notion.com/v1/databases/" + dbId + "/query", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + NOTION_KEY,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });

  const data = await r.json().catch(function () {
    return {};
  });

  if (!r.ok) {
    console.error("[notion_error]", data);
    throw new Error(data && data.message ? data.message : "Notion query error");
  }

  return data;
}

/* =========================
   Notion 欄位讀取
========================= */

function readTitleOrRichText(prop) {
  if (!prop) return "";

  if (prop.type === "title") {
    return Array.isArray(prop.title)
      ? prop.title.map(function (x) { return x.plain_text || ""; }).join("").trim()
      : "";
  }

  if (prop.type === "rich_text") {
    return readRichText(prop);
  }

  return "";
}

function readRichText(prop) {
  if (!prop) return "";

  if (prop.type === "rich_text") {
    return Array.isArray(prop.rich_text)
      ? prop.rich_text.map(function (x) { return x.plain_text || ""; }).join("").trim()
      : "";
  }

  if (prop.rich_text) {
    return prop.rich_text.map(function (x) { return x.plain_text || ""; }).join("").trim();
  }

  return "";
}

function readSelect(prop) {
  if (!prop) return "";

  if (prop.type === "select") {
    return prop.select ? prop.select.name || "" : "";
  }

  if (prop.type === "status") {
    return prop.status ? prop.status.name || "" : "";
  }

  return "";
}

function readMultiSelect(prop) {
  if (!prop) return "";

  if (prop.type === "multi_select") {
    return Array.isArray(prop.multi_select)
      ? prop.multi_select.map(function (x) { return x.name || ""; }).filter(Boolean).join("、")
      : "";
  }

  return "";
}

function readSelectOrMultiSelect(prop) {
  if (!prop) return "";

  if (prop.type === "select") {
    return prop.select ? prop.select.name || "" : "";
  }

  if (prop.type === "multi_select") {
    return Array.isArray(prop.multi_select)
      ? prop.multi_select.map(function (x) { return x.name || ""; }).filter(Boolean).join("、")
      : "";
  }

  if (prop.type === "rich_text") {
    return readRichText(prop);
  }

  return "";
}

/* =========================
   通用工具
========================= */

function normalizeText(s) {
  return String(s || "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(arr) {
  const seen = {};
  const out = [];

  for (const item of arr || []) {
    const value = normalizeText(item);
    if (!value) continue;
    if (seen[value]) continue;

    seen[value] = true;
    out.push(value);
  }

  return out;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("[json_parse_failed]", text);
    return null;
  }
}

function safeReadPrompt(fileName) {
  try {
    return readPrompt(fileName);
  } catch (e) {
    console.error("[safeReadPrompt]", e.message || String(e));
    return "";
  }
}
