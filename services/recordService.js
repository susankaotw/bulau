const {
  notionCreatePage,
  notionPatchPage,
  notionGetPage
} = require("./notionService");

const RECORD_DB  = process.env.RECORD_DB_ID || "";

const REC_TITLE = "標題";
const REC_EMAIL = "Email";
const REC_UID   = "UserId";
const REC_CATE  = "類別";
const REC_BODY  = "內容";
const REC_DATE  = "日期";
const REC_SRC   = "來源";
const REC_AI    = "AI回覆";
const REC_SEG   = "對應脊椎分節";

const REC_AI_TYPE      = "AI判斷類型";
const REC_HIT          = "是否命中資料";
const REC_NEED_REVIEW  = "是否需要人工補充";
const REC_ADD_TO_KB    = "是否納入知識庫";
const REC_RISK         = "風險標記";
const REC_MATCHED_KB   = "命中知識庫標題";
const REC_ADMIN_NOTE   = "管理備註";

const REC_AI_SCORE = "AI自評分數";
const REC_AI_REASON = "AI自評理由";

async function writeRecord({ email, userId, category, content, source = "LINE" }) {
  const nowISO = new Date().toISOString();
  const nowTW = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const props = {
    [REC_TITLE]: { title: [{ text: { content: `${category}｜${nowTW}` } }] },
    [REC_EMAIL]: { email },
    [REC_UID]: { rich_text: [{ text: { content: userId } }] },
    [REC_CATE]: { select: { name: category } },
    [REC_BODY]: { rich_text: [{ text: { content } }] },
    [REC_DATE]: { date: { start: nowISO } },
    [REC_SRC]: { rich_text: [{ text: { content: source } }] }
  };

  const { ok, json } = await notionCreatePage(RECORD_DB, props);

  if (!ok) console.error("[writeRecord] create failed", json);
  return json?.id || "";
}

async function patchRecordById(pageId, {
  seg,
  tip,
  routerType,
  matched,
  needReview,
  risk,
  matchedKb,
  adminNote,
  aiScore,
  aiReason
}) {
  if (!pageId) return;

  const page = await notionGetPage(pageId);
  const propsNow = page?.properties || {};
  const outProps = {};

  if (typeof seg !== "undefined" && propsNow[REC_SEG]) {
    outProps[REC_SEG] = buildPropValueByType(propsNow[REC_SEG], seg ?? "");
  }

  if (typeof tip !== "undefined" && propsNow[REC_AI]) {
    outProps[REC_AI] = buildPropValueByType(propsNow[REC_AI], tip ?? "");
  }

  if (typeof routerType !== "undefined" && propsNow[REC_AI_TYPE]) {
    outProps[REC_AI_TYPE] = buildPropValueByType(propsNow[REC_AI_TYPE], routerType ?? "");
  }

  if (typeof matched !== "undefined" && propsNow[REC_HIT]) {
    outProps[REC_HIT] = buildPropValueByType(propsNow[REC_HIT], Boolean(matched));
  }

  if (typeof needReview !== "undefined" && propsNow[REC_NEED_REVIEW]) {
    outProps[REC_NEED_REVIEW] = buildPropValueByType(propsNow[REC_NEED_REVIEW], Boolean(needReview));
  }

  if (propsNow[REC_ADD_TO_KB]) {
    outProps[REC_ADD_TO_KB] = buildPropValueByType(propsNow[REC_ADD_TO_KB], false);
  }

  if (typeof risk !== "undefined" && propsNow[REC_RISK]) {
    outProps[REC_RISK] = buildPropValueByType(propsNow[REC_RISK], risk || "無");
  }

  if (typeof matchedKb !== "undefined" && propsNow[REC_MATCHED_KB]) {
    outProps[REC_MATCHED_KB] = buildPropValueByType(propsNow[REC_MATCHED_KB], matchedKb || "");
  }

  if (typeof adminNote !== "undefined" && propsNow[REC_ADMIN_NOTE]) {
    outProps[REC_ADMIN_NOTE] = buildPropValueByType(propsNow[REC_ADMIN_NOTE], adminNote || "");
  }

  if (typeof aiScore !== "undefined" && propsNow[REC_AI_SCORE]) {
  outProps[REC_AI_SCORE] = buildPropValueByType(propsNow[REC_AI_SCORE], aiScore);
}

if (typeof aiReason !== "undefined" && propsNow[REC_AI_REASON]) {
  outProps[REC_AI_REASON] = buildPropValueByType(propsNow[REC_AI_REASON], aiReason || "");
}

  const keys = Object.keys(outProps);

  if (!keys.length) {
    console.warn("[patchRecordById] no matched properties to update");
    return;
  }

  const ok = await notionPatchPage(pageId, { properties: outProps });

  if (!ok) console.error("[patchRecordById] failed", outProps);
}

function buildPropValueByType(propItem, value) {
  if (!propItem || !propItem.type) {
    return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };
  }

  switch (propItem.type) {
    case "title":
      return { title: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };

    case "rich_text":
      return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };

    case "select":
      return {
        select: {
          name: String(value ?? "").split(/[、,，\s]/).filter(Boolean)[0] || "—"
        }
      };

    case "multi_select":
      return {
        multi_select: String(value ?? "")
          .split(/[、,，\s]/)
          .filter(Boolean)
          .slice(0, 20)
          .map(n => ({ name: n }))
      };

    case "checkbox":
      return { checkbox: Boolean(value) };

    case "number": {
      const n = Number(value);
      return { number: Number.isFinite(n) ? n : null };
}

    case "email":
      return { email: String(value ?? "") };

    case "date":
      return { date: { start: String(value || new Date().toISOString()) } };

    default:
      return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };
  }
}

async function createCandidateFromRecord(recordId, recordData) {
  if (!process.env.AI_CANDIDATE_DB_ID) return;

  try {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: {
          database_id: process.env.AI_CANDIDATE_DB_ID
        },
        properties: {
          問題: {
            title: [
              {
                text: {
                  content: recordData.query || "未命名問題"
                }
              }
            ]
          },
          來源查詢紀錄: {
            relation: [
              {
                id: recordId
              }
            ]
          }
        }
      })
    });
  } catch (err) {
    console.error("[createCandidateFromRecord error]", err);
  }
}

module.exports = {
  writeRecord,
  patchRecordById,
  buildPropValueByType,
  createCandidateFromRecord
};
