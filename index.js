#!/usr/bin/env node
/**
 * 简单文本传输服务 - 从远程设备浏览器提交文本保存到本地文件
 * 用法: npx text-server [端口号]
 * 默认端口: 8765
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL, URLSearchParams } = require("url");

const PORT = parseInt(process.argv[2], 10) || 8765;
const SAVE_DIR = path.join(process.cwd(), "received_texts");

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>文本传输</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
    min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; padding: 20px;
  }
  h1 { font-size: 1.5rem; margin-bottom: 16px; color: #38bdf8; }
  .container { width: 100%; max-width: 800px; display: flex; flex-direction: column; gap: 12px; }
  form { display: flex; flex-direction: column; gap: 12px; }
  textarea {
    width: 100%; height: 55vh; min-height: 300px; padding: 16px;
    font-size: 16px; font-family: "SF Mono","Fira Code","Consolas",monospace; line-height: 1.6;
    background: #1e293b; color: #f1f5f9; border: 2px solid #334155;
    border-radius: 12px; resize: vertical; outline: none; transition: border-color .2s;
  }
  textarea:focus { border-color: #38bdf8; }
  .filename-row { display: flex; gap: 8px; align-items: center; }
  .filename-row label { font-size: .9rem; color: #94a3b8; white-space: nowrap; }
  .filename-row input {
    flex: 1; padding: 10px 14px; font-size: 15px;
    background: #1e293b; color: #f1f5f9; border: 2px solid #334155;
    border-radius: 8px; outline: none;
  }
  .filename-row input:focus { border-color: #38bdf8; }
  button {
    padding: 14px 24px; font-size: 1.1rem; font-weight: 600;
    background: #0284c7; color: #fff; border: none; border-radius: 10px;
    cursor: pointer; transition: background .2s, transform .1s;
  }
  button:hover { background: #0369a1; }
  button:active { transform: scale(.98); }
  .msg {
    padding: 12px 16px; border-radius: 8px; font-size: .95rem;
  }
  .msg-success { background: #064e3b; color: #6ee7b7; }
  .msg-error { background: #7f1d1d; color: #fca5a5; }
  .history { margin-top: 8px; font-size: .85rem; color: #64748b; }
  .history ul { list-style: none; padding: 0; }
  .history li { padding: 4px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>📋 文本传输</h1>
  %%STATUS%%
  <form method="POST" action="/save">
    <div class="filename-row">
      <label for="filename">文件名:</label>
      <input type="text" name="filename" id="filename" placeholder="留空则按时间自动命名">
    </div>
    <textarea name="text" id="text" placeholder="在此粘贴或输入文本内容..." autofocus></textarea>
    <button type="submit">💾 保存到此设备</button>
  </form>
  %%HISTORY%%
</div>
</body>
</html>`;

/** HTML 转义 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 格式化时间 */
function formatTime(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 格式化时间戳为文件名 */
function timestampFilename() {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}_${h}${mi}${s}.txt`;
}

/** 获取已保存文件列表 */
function getHistoryFiles() {
  if (!fs.existsSync(SAVE_DIR) || !fs.statSync(SAVE_DIR).isDirectory()) {
    return [];
  }
  const entries = fs.readdirSync(SAVE_DIR);
  const files = entries
    .map((name) => {
      const fp = path.join(SAVE_DIR, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) return null;
        return {
          name,
          size: st.size,
          time: formatTime(new Date(st.mtimeMs)),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 20);
  return files;
}

/** 保存文本到文件 */
function saveText(text, filename) {
  if (!text) {
    return { ok: false, msg: "文本内容为空" };
  }

  fs.mkdirSync(SAVE_DIR, { recursive: true });

  if (!filename) {
    filename = timestampFilename();
  }
  // 过滤非法字符
  filename = filename.replace(/[^a-zA-Z0-9._\- ]/g, "").trim();
  if (!filename) {
    filename = timestampFilename();
  }
  if (!filename.includes(".")) {
    filename += ".txt";
  }

  let filepath = path.join(SAVE_DIR, filename);
  const ext = path.extname(filepath);
  const base = filepath.slice(0, filepath.length - ext.length);
  let counter = 1;
  while (fs.existsSync(filepath)) {
    filepath = `${base}_${counter}${ext}`;
    counter++;
  }

  fs.writeFileSync(filepath, text, "utf-8");

  const rel = path.relative(path.dirname(SAVE_DIR), filepath);
  const size = fs.statSync(filepath).size;
  console.log(`  ✅ 已保存: ${filepath} (${size} 字节)`);
  return { ok: true, msg: `已保存: ${rel} (${size} 字节)` };
}

/** 构建页面 */
function buildPage(statusHtml, historyFiles) {
  let page = HTML_PAGE.replace("%%STATUS%%", statusHtml || "");

  let historyHtml = "";
  if (historyFiles && historyFiles.length > 0) {
    const items = historyFiles
      .map(
        (f) =>
          `<li>📄 ${escapeHtml(f.name)} <span style="color:#475569">(${f.size} 字节, ${f.time})</span></li>`
      )
      .join("");
    historyHtml = `<div class="history"><p>已保存的文件:</p><ul>${items}</ul></div>`;
  }
  page = page.replace("%%HISTORY%%", historyHtml);
  return page;
}

/** 发送 HTML 响应 */
function sendHtml(res, html, code = 200) {
  const body = Buffer.from(html, "utf-8");
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

/** 重定向 */
function redirect(res, location) {
  res.writeHead(303, { Location: location, "Content-Length": 0 });
  res.end();
}

/** 解析 POST body */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const params = new URLSearchParams(raw);
        resolve({
          text: params.get("text") || "",
          filename: (params.get("filename") || "").trim(),
        });
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** 获取局域网 IP */
function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

/** 请求处理 */
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`  [${timestamp}] ${req.method} ${pathname}`);

  if (req.method === "GET" && pathname === "/") {
    // 检查 query string 中的状态消息
    let statusHtml = "";
    const msg = parsedUrl.searchParams.get("msg");
    const ok = parsedUrl.searchParams.get("ok");
    if (msg) {
      const css = ok === "1" ? "msg-success" : "msg-error";
      const icon = css === "msg-success" ? "✅" : "❌";
      statusHtml = `<div class="msg ${css}">${icon} ${escapeHtml(msg)}</div>`;
    }
    const page = buildPage(statusHtml, getHistoryFiles());
    sendHtml(res, page);
  } else if (req.method === "POST" && pathname === "/save") {
    try {
      const { text, filename } = await parseBody(req);
      const result = saveText(text, filename);
      redirect(
        res,
        `/?ok=${result.ok ? "1" : "0"}&msg=${encodeURIComponent(result.msg)}`
      );
    } catch (e) {
      redirect(res, `/?ok=0&msg=${encodeURIComponent(String(e))}`);
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  📋 文本传输服务已启动`);
  console.log("=".repeat(50));
  console.log(`\n  本机访问:  http://localhost:${PORT}`);

  const lanIP = getLanIP();
  if (lanIP) {
    console.log(`  局域网访问: http://${lanIP}:${PORT}`);
    console.log(`  👆 在另一台设备浏览器中打开上面的地址`);
  } else {
    console.log("  (无法获取局域网 IP，请手动查看)");
  }

  console.log(`\n  保存目录: ${SAVE_DIR}`);
  console.log(`  按 Ctrl+C 停止服务\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ❌ 端口 ${PORT} 已被占用，请换一个端口试试`);
    console.error(`  用法: npx text-server [端口号]\n`);
  } else {
    console.error(`\n  ❌ 服务启动失败: ${err.message}\n`);
  }
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\n  服务已停止");
  server.close();
  process.exit(0);
});
