const trim = (s) => String(s || "").trim();

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));

const normalizeText = (s) => trim(String(s || "").replace(/\u3000/g, " ").replace(/\s+/g, " "));

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function shortId(id) {
  return id ? id.replace(/-/g, "").slice(0, 8) : "";
}

module.exports = {
  trim,
  isEmail,
  normalizeText,
  safeText,
  fmtDate,
  shortId
};
