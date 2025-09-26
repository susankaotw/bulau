// api/env.js
module.exports = (req, res) => {
  res.status(200).json({
    has_DB_ID: !!process.env.NOTION_DB_ID,
    has_TOKEN: !!process.env.NOTION_TOKEN,
    token_prefix: (process.env.NOTION_TOKEN || "").slice(0, 6) // 只顯示前6碼
  });
};
