// Minimal static server for local testing: `node serve.js`, then open
// http://localhost:8765. Module scripts and fetch() need a real origin, so the app
// can't be opened straight off the filesystem.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8765;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)){ res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err){ res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Dev server: http://localhost:${PORT}`));
