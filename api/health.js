// api/health.js
// 檢查環境變數與 Notion 連線／欄位偵測

const { Client } = require("@notionhq/client");

function short(id) {
  if (!id) return "";
  const s = String(id).replace(/[^a-zA-Z0-9]/g, "");
  return s.slice(0, 6) + "…" + s.slice(-6);
}

module.exports = async (req, res) => {
  try {
    const token = process.env.NOTION_TOKEN;
    const qaId = process.env.NOTION_DB_ID;
    const memId = process.env.NOTION_MEMBER_DB_ID;

    const env = {
      has_token: !!token,
      has_qa_db_id: !!qaId,
      has_member_db_id: !!memId,
      qa_db_id: short(qaId),
      member_db_id: short(memId),
    };

    let qaRetrieve = null;
    let memRetrieve = null;
    let fields = null;

    if (!token) {
      return res.status(200).json({ env, qaRetrieve, memRetrieve, fields, note: "NOTION_TOKEN 缺少或未生效" });
    }

    const notion = new Client({ auth: token });

    // 讀 QA DB
    if (qaId) {
      try {
        const db = await notion.databases.retrieve({ database_id: qaId });
        qaRetrieve = { ok: true, title: db.title?.[0]?.plain_text || "" };
      } catch (e) {
        qaRetrieve = { ok: false, error: String(e.message || e) };
      }
    }

    // 讀 會員 DB 並偵測欄位
    if (memId) {
      try {
        const db = await notion.databases.retrieve({ database_id: memId });
        memRetrieve = { ok: true, title: db.title?.[0]?.plain_text || "" };

        const props = db.properties || {};
        let emailField = null, statusName = null, expiryName = null, levelName = null;

        // Email 欄：type=email 優先；否則名稱包含 email/e-mail/mail/信箱/電子郵件/邮箱 + rich_text/title
        for (const [name, def] of Object.entries(props)) {
          if (def?.type === "email") { emailField = { name, type: "email" }; break; }
        }
        if (!emailField) {
          for (const [name, def] of Object.entries(props)) {
            const t = def?.type;
            if (/(email|e-mail|mail|信箱|電子郵件|邮箱)/i.test(name) && (t === "rich_text" || t === "title" || t === "formula")) {
              emailField = { name, type: t }; break;
            }
          }
        }

        // 狀態 / 到期 / 等級（可有可無）
        for (const [name, def] of Object.entries(props)) {
          const t = def?.type;
          if (!statusName && (t === "status" || t === "select") && /(狀態|status)/i.test(name)) statusName = name;
          if (!expiryName && t === "date" && /(有效|期限|到期|expire|expiry)/i.test(name)) expiryName = name;
          if (!levelName && (t === "select" || t === "multi_select") && /(等級|級別|level)/i.test(name)) levelName = name;
        }

        fields = { emailField, statusName, expiryName, levelName };
      } catch (e) {
        memRetrieve = { ok: false, error: String(e.message || e) };
      }
    }

    res.status(200).json({ env, qaRetrieve, memRetrieve, fields });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
};
