function pickReply(ans) {
  if (!ans) return "";
  if (typeof ans === "string") return ans;
  if (ans.reply) return String(ans.reply);
  if (ans.data && ans.data.reply) return String(ans.data.reply);
  if (ans.body && ans.body.reply) return String(ans.body.reply);
  if (ans.raw && typeof ans.raw === "string") return ans.raw;
  return "";
}

function coerceList(ans) {
  if (Array.isArray(ans?.results)) return ans.results;
  if (Array.isArray(ans?.items)) return ans.items;

  if (pickReply(ans)) return [];

  if (ans?.answer && typeof ans.answer === "object") return [ans.answer];

  return [];
}

async function postJSON(url, body, timeoutMs = 30000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body || {}),
      signal: ac.signal
    });

    const txt = await r.text();
    let json;

    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt };
    }

    json.http = r.status;
    return json;
  } catch (e) {
    console.error("[postJSON]", e?.message || e);
    return {
      ok: false,
      error: e?.message || "fetch_failed"
    };
  } finally {
    clearTimeout(id);
  }
}

module.exports = {
  postJSON,
  pickReply,
  coerceList
};
