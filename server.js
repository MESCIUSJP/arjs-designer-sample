// HTTPサーバーの作成、ファイル操作、パス確認、一時ファイル名の生成に使うNode.js標準機能を読み込みます。
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// サーバーの配置場所を基準に、Reportsフォルダーや設定値の場所を決めます。
const root = __dirname;
const reportsDirectory = path.join(root, "Reports");
const port = Number(process.env.PORT || 3000);
// 待ち受けるIPアドレスは環境変数HOSTで変更でき、未指定時はこのPC内からのみ接続できます。
const host = process.env.HOST || "127.0.0.1";
// ブラウザーに表示するオリジン全体は環境変数ORIGINで指定でき、通常は待ち受け先から自動で作ります。
const origin = process.env.ORIGIN || `http://${host}:${port}`;
const maxRequestBytes = 10 * 1024 * 1024;

// APIの結果をJSONで返し、ブラウザーが安全に扱えるためのHTTPヘッダーも設定します。
function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

// ファイル名の拡張子を除いた部分を検査し、パス区切りやOSで使えない名前を拒否します。
// 末尾のドット／空白やWindowsの予約名も保存先として使用できません。
function validateBaseName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(value)) return false;
  if (/[. ]$/.test(value) || /^[.]+$/.test(value)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

// レポート用の拡張子が付いていることを確認してから、ファイル名本体も検査します。
function validateReportFileName(value) {
  if (typeof value !== "string" || !value.toLowerCase().endsWith(".rdlx-json")) return false;
  return validateBaseName(value.slice(0, -".rdlx-json".length));
}

// レポート定義の構造から、ページレポートかRDLレポートかを判定します。
// FixedPageはページレポート、ReportSectionsまたはBody.ReportItemsはRDLレポートの特徴です。
function detectReportType(definition) {
  const hasFixedPage = Boolean(definition?.FixedPage);
  const hasReportSections = Boolean(definition?.ReportSections);
  const hasRdlBody = Array.isArray(definition?.Body?.ReportItems);

  if (hasFixedPage && !hasReportSections) return "page";
  if (hasReportSections && !hasFixedPage) return "rdl";
  if (hasRdlBody && !hasFixedPage) return "rdl";
  return null;
}

// ブラウザーから届いたJSONを読み込み、サイズ上限とJSON形式を確認します。
async function readRequestJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxRequestBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

// 保存・読込対象を Reports 直下の通常ファイルに限定します。
// ファイル名の再検証に加え、シンボリックリンクも確認し、フォルダー外への参照を拒否します。
async function getRegularReportPath(fileName) {
  if (!validateReportFileName(fileName)) return undefined;
  const reportPath = path.join(reportsDirectory, fileName);
  const resolvedPath = path.resolve(reportPath);
  if (path.dirname(resolvedPath) !== reportsDirectory) return undefined;
  try {
    const stats = await fs.lstat(resolvedPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    const realPath = await fs.realpath(resolvedPath);
    if (path.dirname(realPath) !== reportsDirectory) return undefined;
    return realPath;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Reports の一覧・読込・保存APIと、ページレポート作成用テンプレートAPIを処理します。
// テンプレートは Reports/template 内の決められたファイルだけを返し、任意のパスは受け付けません。
async function handleApi(request, response, url) {
  if (url.pathname === "/api/templates/page-report" && request.method === "GET") {
    const templateDirectory = path.join(reportsDirectory, "template");
    const templatePath = path.join(templateDirectory, "pagereports-template.rdlx-json");
    try {
      const directoryStats = await fs.lstat(templateDirectory);
      const templateStats = await fs.lstat(templatePath);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || !templateStats.isFile() || templateStats.isSymbolicLink()) {
        sendJson(response, 404, { error: "Page report template not found." });
        return;
      }
      if (await fs.realpath(templateDirectory) !== templateDirectory || await fs.realpath(templatePath) !== templatePath) {
        sendJson(response, 404, { error: "Page report template not found." });
        return;
      }
      const definition = JSON.parse(await fs.readFile(templatePath, "utf8"));
      if (!definition || typeof definition !== "object" || Array.isArray(definition) || !definition.Page || !definition.FixedPage) {
        sendJson(response, 500, { error: "Page report template is invalid." });
        return;
      }
      sendJson(response, 200, { definition });
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Unable to load the page report template." });
    }
    return;
  }

  const parts = url.pathname.split("/");
  if (parts.length < 3 || parts[1] !== "api" || parts[2] !== "reports") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  // 開くダイアログに表示するため、Reports直下のレポートファイルだけを一覧にします。
  if (parts.length === 3 && request.method === "GET") {
    const entries = await fs.readdir(reportsDirectory, { withFileTypes: true });
    const reports = entries
      .filter((entry) => entry.isFile() && validateReportFileName(entry.name))
      .map((entry) => ({ fileName: entry.name, displayName: entry.name.slice(0, -".rdlx-json".length) }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "ja"));
    sendJson(response, 200, { reports });
    return;
  }

  if (parts.length !== 4 || !["GET", "PUT"].includes(request.method)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  let fileName;
  try {
    fileName = decodeURIComponent(parts[3]);
  } catch {
    sendJson(response, 400, { error: "Invalid file name." });
    return;
  }
  if (!validateReportFileName(fileName)) {
    sendJson(response, 400, { error: "Invalid file name." });
    return;
  }

  // 指定レポートのJSON定義と形式を返し、画面側でデザイナーに読み込めるようにします。
  if (request.method === "GET") {
    const reportPath = await getRegularReportPath(fileName);
    if (!reportPath) {
      sendJson(response, 404, { error: "Report not found." });
      return;
    }
    try {
      const definition = JSON.parse(await fs.readFile(reportPath, "utf8"));
      if (!detectReportType(definition)) {
        sendJson(response, 400, { error: "Unable to determine the report type from this definition." });
        return;
      }
      sendJson(response, 200, { definition });
    } catch {
      sendJson(response, 400, { error: "Report file does not contain valid JSON." });
    }
    return;
  }

  let body;
  try {
    body = await readRequestJson(request);
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.definition || typeof body.definition !== "object" || Array.isArray(body.definition)) {
    sendJson(response, 400, { error: "A report definition is required." });
    return;
  }
  if (!detectReportType(body.definition)) {
    sendJson(response, 400, { error: "Unable to determine the report type from this definition." });
    return;
  }

  // 新規保存では既存ファイルを誤って置き換えないよう排他的に作成します。
  // 上書き保存は一時ファイルを完成させてから置き換え、保存中の不完全な定義が残らないようにします。
  let targetPath = await getRegularReportPath(fileName);
  const exists = Boolean(targetPath);
  const overwrite = url.searchParams.get("overwrite") === "true";
  if (exists && !overwrite) {
    sendJson(response, 409, { error: "A report with this name already exists." });
    return;
  }
  if (!exists) {
    try {
      await fs.access(path.join(reportsDirectory, fileName));
      sendJson(response, 400, { error: "The target is not a regular report file." });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    targetPath = path.join(reportsDirectory, fileName);
  }

  const serialized = JSON.stringify(body.definition, null, 2);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > maxRequestBytes) {
    sendJson(response, 413, { error: "Report definition is too large." });
    return;
  }
  try {
    if (exists && overwrite) {
      const temporaryPath = path.join(reportsDirectory, `${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temporaryPath, serialized, { flag: "wx" });
      await fs.rename(temporaryPath, targetPath);
    } else {
      await fs.writeFile(targetPath, serialized, { flag: "wx" });
    }
    sendJson(response, 200, { fileName });
  } catch (error) {
    if (error.code === "EEXIST") {
      sendJson(response, 409, { error: "A report with this name already exists." });
    } else {
      sendJson(response, 500, { error: "Unable to save the report." });
    }
  }
}

// ブラウザーへ配信する画面ファイルを許可リストに限定します。
// デザイナーはライブラリの id に指定されたURLからパーツ定義を取得するため、Reports/Parts 内の .rdlx-json だけを例外的に配信します。
// Reports内の通常のレポートやテンプレート、管理情報はこの静的配信経由では公開しません。
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/main.js", ["main.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/license.js", ["license.js", "text/javascript; charset=utf-8"]],
]);

// HTML・JavaScript・CSSと、許可したレポートパーツだけをブラウザーへ配信します。
async function handleStatic(request, response, url) {
  if (request.method !== "GET") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  let relativePath;
  let contentType;
  const knownFile = staticFiles.get(url.pathname);
  if (knownFile) {
    [relativePath, contentType] = knownFile;
  } else if (url.pathname.startsWith("/Reports/Parts/")) {
    // 部品ライブラリのURLに指定する単一ファイル名のみ受け付け、フォルダー移動や別形式のファイルを拒否します。
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      sendJson(response, 400, { error: "Invalid path." });
      return;
    }
    const fileName = decodedPath.slice("/Reports/Parts/".length);
    if (!/^[\p{L}\p{N}_.-]+\.rdlx-json$/iu.test(fileName)) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    relativePath = path.join("Reports", "Parts", fileName);
    contentType = "application/json; charset=utf-8";
  } else {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, "index.html")) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    if (relativePath.startsWith(path.join("Reports", "Parts") + path.sep)) {
      const partsDirectory = path.join(reportsDirectory, "Parts");
      const realPath = await fs.realpath(filePath);
      const relativeToParts = path.relative(partsDirectory, realPath);
      if (relativeToParts === ".." || relativeToParts.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToParts)) {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
    }
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Unable to read the requested file." });
  }
}

// 受信したURLを調べ、API処理か画面ファイルの配信処理へ振り分けます。
async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else {
      await handleStatic(request, response, url);
    }
  } catch {
    if (!response.headersSent) sendJson(response, 500, { error: "Unexpected server error." });
    else response.destroy();
  }
}

// サーバー起動時にReportsフォルダーを準備し、通常のフォルダーであることを確認してから待受を始めます。
fs.mkdir(reportsDirectory, { recursive: true }).then(async () => {
  const stats = await fs.lstat(reportsDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The Reports path must be a directory, not a symbolic link.");
  }
  http.createServer(handleRequest).listen(port, host, () => {
      console.log(`ActiveReportsJS Designer sample running at ${origin}`);
  });
}).catch((error) => {
  console.error("Unable to prepare the Reports directory:", error);
  process.exitCode = 1;
});
