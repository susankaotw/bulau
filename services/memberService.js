const { isEmail, fmtDate } = require("./textUtils");
const {
  notionQueryDatabase,
  notionPatchPage
} = require("./notionService");

const MEMBER_DB  = process.env.NOTION_MEMBER_DB_ID || "";

const MEMBER_EMAIL_PROP  = "Email";
const MEMBER_LINE_PROP   = "LINE UserId";
const MEMBER_STATUS_PROP = "狀態";
const MEMBER_LEVEL_PROP  = "等級";
const MEMBER_EXPIRE_PROP = "有效日期";

const BLOCK_STATUS_NAMES = ["停用", "封鎖", "黑名單", "禁用"];
const CHECK_EXPIRE = true;

async function ensureMemberAllowed(userId) {
  const info = await getMemberInfoByLineId(userId);

  if (!info || !isEmail(info.email)) {
    return {
      ok: false,
      email: "",
      hint: "尚未綁定 Email。請輸入「綁定 你的Email」，例如：綁定 test@example.com"
    };
  }

  const statusName = String(info.status || "").trim();

  if (statusName && BLOCK_STATUS_NAMES.includes(statusName)) {
    return {
      ok: false,
      email: info.email,
      hint: `此帳號狀態為「${statusName}」，暫停使用查詢/簽到/心得功能。`
    };
  }

  if (CHECK_EXPIRE && info.expire) {
    const expDate = new Date(info.expire);
    const today = new Date(new Date().toDateString());

    if (String(expDate) !== "Invalid Date" && expDate < today) {
      return {
        ok: false,
        email: info.email,
        hint: `此帳號已過有效日期（${fmtDate(info.expire)}）。`
      };
    }
  }

  return { ok: true, email: info.email, status: info.status, expire: info.expire };
}

async function getMemberInfoByLineId(userId) {
  if (!MEMBER_DB || !userId) return null;

  const r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_LINE_PROP, rich_text: { equals: userId } },
    page_size: 1
  });

  if (!r?.results?.length) return null;

  const p = r.results[0]?.properties || {};
  const email = readPropEmail(p, MEMBER_EMAIL_PROP);
  const status = p[MEMBER_STATUS_PROP]?.select?.name || "";
  const level = p[MEMBER_LEVEL_PROP]?.select?.name || "";
  const expire = p[MEMBER_EXPIRE_PROP]?.date?.start || "";
  const lineBind = (p[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();

  return { email, status, level, expire, lineBind };
}

async function bindEmailToLine(userId, email) {
  if (!MEMBER_DB || !userId || !isEmail(email)) return false;

  let r = await notionQueryDatabase(MEMBER_DB, {
    filter: { property: MEMBER_EMAIL_PROP, email: { equals: email } },
    page_size: 1
  });

  if (!r?.results?.length) {
    r = await notionQueryDatabase(MEMBER_DB, {
      filter: { property: MEMBER_EMAIL_PROP, rich_text: { equals: email } },
      page_size: 1
    });
  }

  if (!r?.results?.length) {
    r = await notionQueryDatabase(MEMBER_DB, {
      filter: { property: MEMBER_EMAIL_PROP, title: { equals: email } },
      page_size: 1
    });
  }

  if (!r?.results?.length) return false;

  const page = r.results[0];
  const pageId = page.id;
  const props = page.properties || {};
  const existing = (props[MEMBER_LINE_PROP]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();

  if (existing) return existing === userId;

  return await notionPatchPage(pageId, {
    properties: {
      [MEMBER_LINE_PROP]: {
        rich_text: [{ text: { content: userId } }]
      }
    }
  });
}

function readPropEmail(props, key) {
  if (!props || !key || !props[key]) return "";

  const e1 = props[key]?.email || "";
  if (e1 && isEmail(e1)) return e1.trim();

  const e2 = (props[key]?.rich_text || []).map(t => t?.plain_text || "").join("").trim();
  if (e2 && isEmail(e2)) return e2;

  const e3 = (props[key]?.title || []).map(t => t?.plain_text || "").join("").trim();
  if (e3 && isEmail(e3)) return e3;

  return "";
}

module.exports = {
  readPropEmail,
  getMemberInfoByLineId,
  bindEmailToLine,
  ensureMemberAllowed
};
