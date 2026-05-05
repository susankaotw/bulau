const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const port = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/manifest.json", (_req, res) => {
  res.setHeader("Content-Type", "application/manifest+json");
  res.sendFile(path.join(__dirname, "manifest.json"));
});

app.get("/service-worker.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "service-worker.js"));
});

app.get("/offline.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "offline.html"));
});

app.get("/logo.png", (_req, res) => {
  try {
    const b64Path = path.join(__dirname, "_logo.b64");
    if (!fs.existsSync(b64Path)) {
      return res.status(404).send("logo not found");
    }

    const lines = fs.readFileSync(b64Path, "utf8").split(/\r?\n/);
    // certutil -encode adds BEGIN/END lines
    const payload = lines.slice(1, -1).join("");
    const buf = Buffer.from(payload, "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).send("logo error");
  }
});

function mountApi(name, handler) {
  const route = `/api/${name}`;
  app.all(route, async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      // 盡量維持與 Vercel handler 類似的錯誤回應
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

mountApi("health", require("./api/health"));
mountApi("answer", require("./api/answer"));
mountApi("line-webhook", require("./api/line-webhook"));
mountApi("env", require("./api/env"));
mountApi("env-dump", require("./api/env-dump"));
mountApi("generate-copy", require("./api/generate-copy"));
mountApi("notion-test", require("./api/notion-test"));
mountApi("notion-search-test", require("./api/notion-search-test"));

app.listen(port, "0.0.0.0", () => {
  console.log(`[server] listening on 0.0.0.0:${port}`);
});

