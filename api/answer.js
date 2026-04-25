// api/answer.js
// 功能：AI 查詢理解層 + Notion 知識庫查詢 + AI 知識融合回答
// 需要檔案：
// /prompts/knowledge-query.md
// /prompts/knowledge-answer.md

const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const NOTION_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
const QA_DB_ID = process.env.NOTION_QA_DB_ID || process.env.NOTION_DB_ID || "";
const NOTION_VER = "2022-06-28";

const QA_QUESTION = "問題";
const QA_TOPIC = "主題";
const QA_SEGMENT = "對應脊椎分節";
const QA_REPLY = "教材版回覆";
const QA_FLOW = "臨床流程建議";
const QA_MERIDIAN = "經絡與補充";
const QA_ENABLED = "是否啟用";

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

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
     const meta = extractAiMeta(reply);

return res.status(200).json({
  ok: true,
  reply: meta.cleanText,
  debug: {
    ai_type: meta.ai_type,
    risk_level: meta.risk_level,
    knowledge_count: knowledgeItems.length,
    normalized_question: queryInfo.normalized_question
  }
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
    const knowledgeItems = await queryNotionKnowledge(queryInfo);
    const reply = await generateAnswerByMd(userMessage, queryInfo, knowledgeItems);

    return res.status(200).json({
      ok: true,
      reply,
      debug: {
        normalized_question: queryInfo.normalized_question,
        query_keywords: queryInfo.query_keywords,
        answer_mode: queryInfo.answer_mode,
        audience: queryInfo.audience,
        knowledge_count: knowledgeItems.length,
        matched_titles: knowledgeItems.map(function (x) {
          return x.question || "";
        }).filter(Boolean)
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
   讀取 .md Prompt
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
      answer_mode: "general",
      audience: "customer",
      only_enabled: true,
      safety_level: "normal"
    };
  }

  const keywords = Array.isArray(parsed.query_keywords)
    ? parsed.query_keywords
    : [userMessage];

  return {
    normalized_question: normalizeText(parsed.normalized_question || userMessage),
    need_knowledge_base: parsed.need_knowledge_base !== false,
    query_keywords: uniqueStrings([userMessage].concat(keywords)).slice(0, 10),
    answer_mode: parsed.answer_mode || "general",
    audience: parsed.audience || "customer",
    only_enabled: parsed.only_enabled !== false,
    safety_level: parsed.safety_level || "normal"
  };
}

/* =========================
   Notion 知識庫查詢
========================= */

async function queryNotionKnowledge(queryInfo) {
  if (!queryInfo || queryInfo.need_knowledge_base === false) return [];

  const keywords = uniqueStrings([
    queryInfo.normalized_question
  ].concat(queryInfo.query_keywords || []))
    .map(function (x) {
      return normalizeText(x);
    })
    .filter(Boolean)
    .slice(0, 10);

  const resultMap = {};

  for (const keyword of keywords) {
    const filters = buildSafeKeywordFilters(keyword);

    for (const filter of filters) {
      try {
        const data = await notionQueryDatabase(QA_DB_ID, {
          filter: filter,
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
          keyword: keyword,
          message: err.message || String(err)
        });
      }
    }
  }

  const pages = Object.keys(resultMap).map(function (id) {
    return resultMap[id];
  });

  return pages
    .map(pageToKnowledgeItem)
    .filter(function (item) {
      return item.question || item.teachingAnswer || item.clinicalSuggestion || item.meridian;
    })
    .slice(0, 8);
}

function buildSafeKeywordFilters(keyword) {
  const filters = [];

  const baseEnabled = {
    property: QA_ENABLED,
    checkbox: {
      equals: true
    }
  };

  // 1. 問題 title contains
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

  // 2. 教材版回覆 rich_text contains
  filters.push({
    and: [
      baseEnabled,
      {
        property: QA_REPLY,
        rich_text: {
          contains: keyword
        }
      }
    ]
  });

  // 3. 對應脊椎分節 rich_text contains
  filters.push({
    and: [
      baseEnabled,
      {
        property: QA_SEGMENT,
        rich_text: {
          contains: keyword
        }
      }
    ]
  });

  // 4. 臨床流程建議 rich_text contains
  filters.push({
    and: [
      baseEnabled,
      {
        property: QA_FLOW,
        rich_text: {
          contains: keyword
        }
      }
    ]
  });

  // 5. 經絡與補充 rich_text contains
  filters.push({
    and: [
      baseEnabled,
      {
        property: QA_MERIDIAN,
        rich_text: {
          contains: keyword
        }
      }
    ]
  });

  // 6. 主題 select 只能查 Notion 已存在選項，避免 select option not found
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
    spine: readRichText(p[QA_SEGMENT]),
    teachingAnswer: readRichText(p[QA_REPLY]),
    clinicalSuggestion: readRichText(p[QA_FLOW]),
    meridian: readRichText(p[QA_MERIDIAN])
  };
}

/* =========================
   AI：知識融合回答層
========================= */

async function generateAnswerByMd(userMessage, queryInfo, knowledgeItems) {
  const prompt = readPrompt("knowledge-answer.md");
  const knowledgeText = formatKnowledgeForAI(knowledgeItems);

  const userContent = [
    "使用者原始問題：",
    userMessage,
    "",
    "查詢理解結果：",
    JSON.stringify(queryInfo, null, 2),
    "",
    "啟用中的知識庫資料：",
    knowledgeText
  ].join("\n");

  const answer = await callOpenAI({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userContent }
    ],
    temperature: 0.35,
    responseFormatJson: false
  });

  return String(answer || "").trim();
}

function extractAiMeta(text) {
  const match = text.match(/【AI判斷】\s*({[\s\S]*?})/);

  if (!match) {
    return {
      ai_type: "一般型",
      risk_level: "無",
      cleanText: text
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
      cleanText: text
    };
  }
}

function formatKnowledgeForAI(items) {
  if (!items || !items.length) {
    return "目前沒有查到啟用中的知識庫資料。";
  }

  return items.map(function (item, index) {
    return [
      "【資料 " + (index + 1) + "】",
      "問題：" + (item.question || "未填"),
      "主題：" + (item.topic || "未填"),
      "對應脊椎分節：" + (item.spine || "未填"),
      "教材版回覆：" + (item.teachingAnswer || "未填"),
      "臨床流程建議：" + (item.clinicalSuggestion || "未填"),
      "經絡與補充：" + (item.meridian || "未填")
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
