// api/answer.js
// V6：資料庫主資料優先 + AI補充分層 + AI自評 + Debug強化
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

// V6 新增支援欄位
const QA_AI_TEACHING = "AI教學說法";
const QA_JUDGEMENT_FLOW = "判斷流程";
const QA_CUSTOMER_SCRIPT = "客戶溝通話術";
const QA_RISK_NOTICE = "風險提醒";
const QA_CONTRAINDICATION = "禁忌標記";
const QA_KEYWORDS = "關鍵字";
const QA_TYPE = "類型";
const QA_BODY_AREA = "身體區域";
const QA_AUDIENCE = "適用對象";

const VALID_TOPICS = [
  "基礎理論",
  "起源與歷史",
  "半脫位",
  "脊椎神經邏輯",
  "筋膜張力",
  "PD檢測",
  "頸椎區段",
  "胸椎區段",
  "腰椎區段",
  "骨盆薦椎",
  "專業型筋膜槍",
  "操作安全",
  "禁忌與轉介",
  "常見疑問",
  "手指對應經絡",
  "臨床補充"
];

/* =========================
   API 入口
========================= */

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        name: "Bulau AI Answer API",
        version: "V6-knowledge-first",
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

    // 1. AI 查詢理解層
    const queryInfo = await analyzeQueryByMd(userMessage);

    if (requestMode === "expand") {
      queryInfo.answer_mode = "AI延伸補充";
    }

    // 2. 查詢 Notion 啟用中的知識庫
    const knowledgeItems = await queryNotionKnowledge(queryInfo, userMessage);

    // 3. 從命中資料中找出「主資料」
    const primaryKnowledgeItem = findPrimaryKnowledgeItem({
      userMessage,
      queryInfo,
      knowledgeItems
    });

    // 4. 決定回答來源模式
    const answerSource = decideAnswerSource({
      requestMode,
      queryInfo,
      knowledgeItems,
      primaryKnowledgeItem
    });

    // 5. 產生第一版回答
    let draftReply = "";

    if (answerSource === "knowledge_first") {
      draftReply = await generateKnowledgeFirstAnswer({
        userMessage,
        queryInfo,
        primaryKnowledgeItem,
        knowledgeItems
      });
    } else if (answerSource === "ai_expand") {
      draftReply = await generateAiExpandAnswer({
        userMessage,
        queryInfo,
        primaryKnowledgeItem,
        knowledgeItems
      });
    } else {
      draftReply = await generateAiFallbackAnswer({
        userMessage,
        queryInfo
      });
    }

    // 6. AI 自評
    const selfReview = await reviewAnswerByAI({
      userMessage,
      queryInfo,
      knowledgeItems,
      primaryKnowledgeItem,
      draftReply,
      answerSource
    });

    // 7. 最終安全整理
    const finalReply = await improveAnswerByAI({
      userMessage,
      queryInfo,
      knowledgeItems,
      primaryKnowledgeItem,
      draftReply,
      selfReview,
      answerSource
    });

    const meta = extractAiMeta(finalReply);

    return res.status(200).json({
      ok: true,
      reply: meta.cleanText,
      debug: {
        version: "V6-knowledge-first",
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
        ai_type: meta.ai_type || selfReview.ai_type || "一般型",
        risk_level: meta.risk_level || selfReview.risk_level || "無",
        hit_knowledge_base: selfReview.hit_knowledge_base,
        need_human_update: selfReview.need_human_update,
        self_review: selfReview
      }
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

function readPrompt(fileName) {
  const filePath = path.join(process.cwd(), "prompts", fileName);

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
    parsed.normalized_question || "",
  ].concat(rawKeywords));

  return {
    normalized_question: normalizeText(parsed.normalized_question || userMessage),
    need_knowledge_base: parsed.need_knowledge_base !== false,
    query_keywords: keywords.slice(0, 10),
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
    .slice(0, 12);

  const resultMap = {};

  for (const keyword of keywords) {
    const filters = buildSafeKeywordFilters(keyword);

    for (const filter of filters) {
      try {
        const data = await notionQueryDatabase(QA_DB_ID, {
          filter,
          page_size: 10,
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
  }).slice(0, 10);
}

function buildSafeKeywordFilters(keyword) {
  const filters = [];

  const baseEnabled = {
    property: QA_ENABLED,
    checkbox: {
      equals: true
    }
  };

  const richTextFields = [
    QA_REPLY,
    QA_SEGMENT,
    QA_FLOW,
    QA_MERIDIAN,
    QA_AI_TEACHING,
    QA_JUDGEMENT_FLOW,
    QA_CUSTOMER_SCRIPT,
    QA_RISK_NOTICE,
    QA_CONTRAINDICATION,
    QA_KEYWORDS,
    QA_BODY_AREA
  ];

  // 問題 title
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

  // 其他 rich_text 欄位
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

  // 主題 select
  if (VALID_TOPICS.indexOf(keyword) >= 0) {
    filters.push({
      and: [
        baseEnabled,
        {
          property: QA_TOPIC,
          select: {
            equals: keyword
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
    contraindication: readRichText(p[QA_CONTRAINDICATION]),
    keywords: readRichText(p[QA_KEYWORDS]),
    bodyArea: readRichText(p[QA_BODY_AREA]),
    audience: readSelect(p[QA_AUDIENCE]),
    _score: 0
  };
}

/* =========================
   V6：主資料優先排序
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

  // 問題欄位精準命中最高
  if (question && raw && question === raw) score += 120;
  if (question && normalized && question === normalized) score += 100;

  if (question && raw && question.includes(raw)) score += 80;
  if (raw && question && raw.includes(question)) score += 70;

  if (question && normalized && question.includes(normalized)) score += 65;
  if (normalized && question && normalized.includes(question)) score += 55;

  // query_keywords 命中問題欄位
  for (const kw of keywords) {
    if (!kw) continue;

    if (question && question === kw) score += 70;
    if (question && question.includes(kw)) score += 45;
    if (kw.includes(question) && question.length >= 2) score += 35;

    if (itemKeywords && itemKeywords.includes(kw)) score += 25;
    if (topic && topic.includes(kw)) score += 15;
    if (type && type.includes(kw)) score += 10;
    if (allText && allText.includes(kw)) score += 8;
  }

  // 內容完整度加分
  if (item.teachingAnswer) score += 8;
  if (item.judgementFlow) score += 10;
  if (item.clinicalSuggestion) score += 8;
  if (item.customerScript) score += 8;
  if (item.aiTeaching) score += 6;
  if (item.riskNotice) score += 4;

  // 避免過短詞過度主導，例如 PD、腳
  if (question.length <= 2 && raw.length >= 4) score -= 20;

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
   V6：回答來源判斷
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
   V6：資料庫優先回答
========================= */

async function generateKnowledgeFirstAnswer({
  userMessage,
  queryInfo,
  primaryKnowledgeItem,
  knowledgeItems
}) {
  const basePrompt = readPrompt("knowledge-answer.md");

  const systemPrompt = [
    basePrompt,
    "",
    "--------------------------------------------------",
    "【V6 強制規則：資料庫主資料優先】",
    "",
    "現在系統已經找到主資料。",
    "你必須以「主命中資料」作為回答主體。",
    "",
    "回答規則：",
    "1. 一定先呈現主命中資料，不可以先講一般知識。",
    "2. 不可以把多筆資料混成泛泛說明。",
    "3. 其他命中資料只能作為補充，不可蓋過主資料。",
    "4. AI只負責整理語氣、補安全說法，不可以改掉教材核心意思。",
    "5. 若欄位空白，可以略過，不要硬補。",
    "6. 若要補充，請放在【AI補充說明】。",
    "7. 如果使用者問操作、怎麼打、怎麼判斷，必須加入安全提醒。",
    "8. 回答最後要有【學員溝通提醒】。",
    "9. 不要提到資料庫、主命中資料、系統內部、debug。",
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
    "提醒避免醫療診斷、療效承諾、因果說法。"
  ].join("\n");

  const userPrompt = [
    "使用者原始問題：",
    userMessage,
    "",
    "查詢理解結果：",
    JSON.stringify(queryInfo, null, 2),
    "",
    "主命中資料：",
    formatSingleKnowledgeForAI(primaryKnowledgeItem),
    "",
    "其他命中資料（只能當補充，不可蓋過主資料）：",
    formatKnowledgeForAI(
      (knowledgeItems || []).filter(function (x) {
        return !primaryKnowledgeItem || x.id !== primaryKnowledgeItem.id;
      }).slice(0, 5)
    ),
    "",
    "請依照 V6 強制規則產生給學員看的回答。"
  ].join("\n");

  const answer = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.2,
    responseFormatJson: false
  });

  return String(answer || "").trim();
}

/* =========================
   V6：AI延伸補充回答
========================= */

async function generateAiExpandAnswer({
  userMessage,
  queryInfo,
  primaryKnowledgeItem,
  knowledgeItems
}) {
  const systemPrompt = [
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

  const userPrompt = [
    "使用者要求延伸補充：",
    userMessage,
    "",
    "查詢理解結果：",
    JSON.stringify(queryInfo, null, 2),
    "",
    "主命中資料：",
    primaryKnowledgeItem ? formatSingleKnowledgeForAI(primaryKnowledgeItem) : "無主命中資料",
    "",
    "其他命中資料：",
    formatKnowledgeForAI((knowledgeItems || []).slice(0, 6)),
    "",
    "請產生延伸補充回答。"
  ].join("\n");

  const answer = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.35,
    responseFormatJson: false
  });

  return String(answer || "").trim();
}

/* =========================
   V6：資料庫無命中 fallback
========================= */

async function generateAiFallbackAnswer({
  userMessage,
  queryInfo
}) {
  const systemPrompt = [
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

  const userPrompt = [
    "使用者問題：",
    userMessage,
    "",
    "查詢理解結果：",
    JSON.stringify(queryInfo, null, 2),
    "",
    "請產生保守、安全、不誇大的回答。"
  ].join("\n");

  const answer = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.3,
    responseFormatJson: false
  });

  return String(answer || "").trim();
}

/* =========================
   AI：自評層
========================= */

async function reviewAnswerByAI(payload) {
  const knowledgeText = formatKnowledgeForAI(payload.knowledgeItems);
  const primaryText = payload.primaryKnowledgeItem
    ? formatSingleKnowledgeForAI(payload.primaryKnowledgeItem)
    : "無主命中資料";

  const systemPrompt = [
    "你是不老AI助理的品質檢查器。",
    "你的任務不是重新回答使用者，而是評估 AI 回答品質。",
    "你必須用嚴格標準判斷：是否命中資料庫、是否需要人工補充、回答信心度、問題類型、風險程度。",
    "請只輸出 JSON，不要輸出其他文字。",
    "",
    "判斷原則：",
    "1. 如果 answer_source = knowledge_first，且有主命中資料，通常 hit_knowledge_base = true。",
    "2. 如果 answer_source = ai_fallback，代表沒有命中知識庫，hit_knowledge_base = false，need_human_update = true。",
    "3. 如果回答內容主要靠一般常識，而不是知識庫內容，判斷為低命中。",
    "4. 如果使用者問題涉及疼痛、麻、無力、暈、胸悶、急性受傷、疾病、診斷、治療，風險提高。",
    "5. 不老AI助理只能做衛教、結構觀念、保養建議，不可做醫療診斷。",
    "",
    "請輸出以下 JSON 格式：",
    "{",
    '  "score": 0到100的整數,',
    '  "confidence": "高" 或 "中" 或 "低",',
    '  "hit_knowledge_base": true 或 false,',
    '  "need_human_update": true 或 false,',
    '  "ai_type": "知識型" 或 "症狀型" 或 "操作型" 或 "風險型" 或 "閒聊型" 或 "未知型",',
    '  "risk_level": "無" 或 "低" 或 "中" 或 "高",',
    '  "normalized_question": "整理後的標準問題",',
    '  "main_gap": "目前回答最大的不足",',
    '  "suggested_update": "建議管理者補進知識庫的內容",',
    '  "reason": "簡短說明判斷理由"',
    "}"
  ].join("\n");

  const userPrompt = [
    "使用者原始問題：",
    payload.userMessage,
    "",
    "answer_source：",
    payload.answerSource,
    "",
    "查詢理解結果：",
    JSON.stringify(payload.queryInfo, null, 2),
    "",
    "主命中資料：",
    primaryText,
    "",
    "全部知識庫資料：",
    knowledgeText,
    "",
    "AI 回答：",
    payload.draftReply
  ].join("\n");

  const content = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    responseFormatJson: true
  });

  const parsed = safeJsonParse(content);

  if (!parsed) {
    const hasKnowledge = !!(payload.knowledgeItems && payload.knowledgeItems.length);

    return {
      score: hasKnowledge ? 70 : 40,
      confidence: hasKnowledge ? "中" : "低",
      hit_knowledge_base: hasKnowledge,
      need_human_update: !hasKnowledge,
      ai_type: "未知型",
      risk_level: "低",
      normalized_question: payload.queryInfo.normalized_question || payload.userMessage,
      main_gap: "AI自評解析失敗，建議人工檢查。",
      suggested_update: "請檢查此題是否需要補充標準答案。",
      reason: "JSON parse failed"
    };
  }

  return {
    score: toInt(parsed.score, 0, 100, 50),
    confidence: normalizeChoice(parsed.confidence, ["高", "中", "低"], "中"),
    hit_knowledge_base: parsed.hit_knowledge_base === true,
    need_human_update: parsed.need_human_update === true,
    ai_type: normalizeChoice(
      parsed.ai_type,
      ["知識型", "症狀型", "操作型", "風險型", "閒聊型", "未知型"],
      "未知型"
    ),
    risk_level: normalizeChoice(parsed.risk_level, ["無", "低", "中", "高"], "低"),
    normalized_question: normalizeText(parsed.normalized_question || payload.queryInfo.normalized_question || payload.userMessage),
    main_gap: normalizeText(parsed.main_gap || ""),
    suggested_update: normalizeText(parsed.suggested_update || ""),
    reason: normalizeText(parsed.reason || "")
  };
}

/* =========================
   AI：最終安全整理
========================= */

async function improveAnswerByAI(payload) {
  const systemPrompt = [
    "你是不老AI助理的最終回答整理器。",
    "",
    "請根據 answer_source 做最後整理，但不要改變核心內容。",
    "",
    "共同規則：",
    "1. 使用繁體中文、台灣用語。",
    "2. 語氣要專業、溫和、清楚、不誇大。",
    "3. 不可做醫療診斷，不可宣稱治療疾病。",
    "4. 可以用結構、肌肉張力、神經訊號、代償、保養、觀察等語言。",
    "5. 若有高風險症狀，提醒尋求合格醫療專業評估。",
    "6. 回答要給使用者看，不要提到 JSON、自評、score、debug。",
    "7. 不要輸出【AI判斷】JSON。",
    "",
    "如果 answer_source = knowledge_first：",
    "請保留【教材重點】【判斷流程】【對客說法】【AI補充說明】【學員溝通提醒】這種教材型結構。",
    "",
    "如果 answer_source = ai_fallback：",
    "一定要保留『目前資料庫還沒有找到這題的完整教材』的意思。",
    "",
    "如果 answer_source = ai_expand：",
    "可以延伸，但要保守，不可診斷。"
  ].join("\n");

  const userPrompt = [
    "answer_source：",
    payload.answerSource,
    "",
    "使用者原始問題：",
    payload.userMessage,
    "",
    "查詢理解結果：",
    JSON.stringify(payload.queryInfo, null, 2),
    "",
    "主命中資料：",
    payload.primaryKnowledgeItem ? formatSingleKnowledgeForAI(payload.primaryKnowledgeItem) : "無主命中資料",
    "",
    "AI 第一版回答：",
    payload.draftReply,
    "",
    "AI 自評結果：",
    JSON.stringify(payload.selfReview, null, 2),
    "",
    "請整理成最終給使用者看的回答。"
  ].join("\n");

  const answer = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.15,
    responseFormatJson: false
  });

  return String(answer || payload.draftReply || "").trim();
}

/* =========================
   AI Meta 擷取
========================= */

function extractAiMeta(text) {
  text = String(text || "");

  const match = text.match(/【AI判斷】\s*({[\s\S]*?})/);

  if (!match) {
    return {
      ai_type: "一般型",
      risk_level: "無",
      cleanText: text.trim()
    };
  }

  try {
    const json = JSON.parse(match[1]);
    const cleanText = text.replace(match[0], "").trim();

    return {
      ai_type: json.ai_type || "一般型",
      risk_level: json.risk_level || "無",
      cleanText
    };
  } catch (e) {
    return {
      ai_type: "一般型",
      risk_level: "無",
      cleanText: text.trim()
    };
  }
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

function toInt(value, min, max, fallback) {
  const n = parseInt(value, 10);

  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function normalizeChoice(value, allowed, fallback) {
  const v = normalizeText(value);

  if (allowed.indexOf(v) >= 0) return v;

  return fallback;
}
