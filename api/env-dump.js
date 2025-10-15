// api/env-dump.js
export default function handler(req, res) {
  const keys = Object.keys(process.env);
  const interesting = keys.filter(k =>
    ["LINE_", "BULAU_", "NOTION_", "RECORD_"].some(p => k.startsWith(p))
  );
  res.status(200).json({
    keys: interesting,
    line_token_len: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").length
  });
}
