// 画面要素の参照と、画面全体で共有する状態をここで用意します。
// 各定数はHTML上の対応する部品を指し、イベント処理や表示更新から何度も利用します。
// currentReportId には、今開いているレポートのファイル名を入れます。まだ保存していない場合は空のままです。
// ファイル名を覚えておくことで、「保存」時に今開いているレポートを正しい場所へ上書きできます。
const statusMessage = document.querySelector("#status-message");
const currentDocument = document.querySelector("#current-document");
const previewDialog = document.querySelector("#preview-dialog");
const createDialog = document.querySelector("#create-dialog");
const openDialog = document.querySelector("#open-dialog");
const saveDialog = document.querySelector("#save-dialog");
const saveNameInput = document.querySelector("#save-name");
const saveError = document.querySelector("#save-error");
const reportList = document.querySelector("#report-list");
let currentReportId;
let designer;
let viewer;

// 画面下部のメッセージを更新し、エラーの場合は見た目も切り替えます。
function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("status-error", isError);
}

// RDLレポートを新しく作るときに、デザイナーが開ける最小限の初期データを用意します。
// ページレポートは必要な設定が多いため、この関数で空の形を作らず、サーバーに置いたテンプレートを使います。
function blankReport(type, name = "新しいレポート") {
  if (type === "page") {
    return { Name: name, Body: { Width: "8.5in", Height: "11in" } };
  }
  return { Name: name, Body: { ReportItems: [] } };
}

// 保存ファイル名から拡張子を取り除き、画面に表示する名前を作ります。
function displayNameFromFile(fileName) {
  return fileName.replace(/\.rdlx-json$/i, "");
}

// ブラウザーからサーバーへ送ったリクエストの結果を確認します。
// 失敗した場合は、サーバーから返された理由をエラーとして呼び出し元へ伝えます。
async function apiRequest(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

// 新規作成画面を開き、選ばれたレポート形式を呼び出し元へ返します。
// 選択せずに画面を閉じたときは、作成を取りやめたものとして扱います。
function chooseCreateType() {
  createDialog.showModal();
  return new Promise((resolve) => {
    // 選択結果を返してダイアログを閉じる共通処理と、閉じる操作の検知を用意します。
    const finish = (type) => {
      createDialog.close();
      createDialog.removeEventListener("close", onClose);
      resolve(type);
    };
    const onClose = () => finish(undefined);
    createDialog.addEventListener("close", onClose, { once: true });
    createDialog.querySelectorAll("[data-report-type]").forEach((button) => {
      button.onclick = () => finish(button.dataset.reportType);
    });
  });
}

// 保存ダイアログを開き、利用者が入力した名前を確認してから返します。
// Reports フォルダーの外へ保存されないよう、名前にパス区切りや禁止文字があれば保存を止めます。
// Windowsでファイル名として使えない予約語や、末尾のドット・空白も受け付けません。
function askForSaveName(initialName) {
  saveNameInput.value = initialName;
  saveError.textContent = "";
  saveDialog.showModal();
  return new Promise((resolve) => {
    // 入力名を呼び出し元へ返す処理と、キャンセル操作の検知を用意します。
    const finish = (name) => {
      saveDialog.close();
      saveDialog.removeEventListener("close", onClose);
      resolve(name);
    };
    const onClose = () => finish(undefined);
    saveDialog.addEventListener("close", onClose, { once: true });
    document.querySelector("#cancel-save").onclick = () => finish(undefined);
    document.querySelector("#confirm-save").onclick = () => {
      // 入力名から拡張子を整え、保存前に禁止文字・形式・予約名をまとめて確認します。
      const name = saveNameInput.value.trim().replace(/\.rdlx-json$/i, "");
      const invalidChars = /[\\/:*?"<>|\u0000-\u001f]/;
      const allowedName = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;
      const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
      if (!name || name.length > 100 || !allowedName.test(name) || invalidChars.test(name) || /^[.]+$/.test(name) || /[. ]$/.test(name) || reservedName.test(name)) {
        saveError.textContent = "名前を入力してください。パスや使用できない文字、予約された名前は指定できません。";
        saveNameInput.focus();
        return;
      }
      finish(name);
    };
  });
}

// Reports フォルダー内の保存済みレポートを一覧表示し、選択したファイルの定義をデザイナーに読み込みます。
// 一覧表示とファイル読込をAPI経由にすることで、ブラウザーからサーバー上のファイルを直接操作しません。
async function chooseReport() {
  try {
    // サーバーから一覧を取得し、ダイアログに表示する前に古い項目を消します。
    const { reports } = await apiRequest("/api/reports");
    reportList.replaceChildren();
    if (!reports.length) {
      const empty = document.createElement("p");
      empty.className = "dialog-empty";
      empty.textContent = "Reports フォルダーにレポートがありません。";
      reportList.append(empty);
    }
    return await new Promise((resolve) => {
      const finish = (report) => {
        openDialog.removeEventListener("close", onClose);
        resolve(report);
      };
      const onClose = () => finish(undefined);
      openDialog.addEventListener("close", onClose, { once: true });
      reports.forEach((report) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "report-list-item";
        button.textContent = report.displayName;
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const savedReport = await apiRequest(`/api/reports/${encodeURIComponent(report.fileName)}`);
            currentReportId = report.fileName;
            currentDocument.textContent = report.displayName;
            setStatus("レポートを開きました。");
            finish({ id: report.fileName, displayName: report.displayName, definition: savedReport.definition });
            openDialog.close();
          } catch (error) {
            button.disabled = false;
            setStatus(`レポートを開けませんでした: ${error.message}`, true);
          }
        });
        reportList.append(button);
      });
      openDialog.showModal();
    });
  } catch (error) {
    setStatus(`レポート一覧を取得できませんでした: ${error.message}`, true);
    return undefined;
  }
}

// デザイナーから受け取ったレポート定義を、サーバーの保存APIへ送ります。
// overwrite が false のときは新しいファイルだけを作り、true のときは同じ名前のファイルを更新します。
// サーバーは定義の内容からレポート形式を確認するため、形式を別ファイルで管理する必要はありません。
async function saveDefinition(fileName, definition, overwrite) {
  return apiRequest(`/api/reports/${encodeURIComponent(fileName)}?overwrite=${overwrite}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definition }),
  });
}

// 保存先の名前を入力して新しいファイルとして保存します。
// すでに同名のファイルがある場合は、確認ダイアログで了承を得てから上書きします。
async function saveAs(info) {
  const initialName = displayNameFromFile(info.id || currentDocument.textContent || "新しいレポート");
  const name = await askForSaveName(initialName || "新しいレポート");
  if (!name) return undefined;
  const fileName = `${name}.rdlx-json`;
  try {
    try {
      await saveDefinition(fileName, info.definition, false);
    } catch (error) {
      if (error.status !== 409 || !window.confirm(`「${name}」は既に存在します。上書きしますか？`)) {
        if (error.status !== 409) throw error;
        return undefined;
      }
      await saveDefinition(fileName, info.definition, true);
    }
    currentReportId = fileName;
    currentDocument.textContent = name;
    setStatus("保存しました。");
    return { id: fileName, displayName: name };
  } catch (error) {
    setStatus(`保存できませんでした: ${error.message}`, true);
    return undefined;
  }
}

// 既存レポートの保存では現在開いているファイル名を使って上書きします。
// 新規レポートには保存先がまだないため、名前を付けて保存する画面へ進みます。
async function saveCurrent(info) {
  if (!currentReportId) return saveAs(info);
  try {
    await saveDefinition(currentReportId, info.definition, true);
    setStatus("保存しました。");
    return { displayName: currentDocument.textContent };
  } catch (error) {
    setStatus(`保存できませんでした: ${error.message}`, true);
    return undefined;
  }
}

// デザイナーから受け取ったレポートをプレビュー画面に表示します。
// Viewerは初回だけ作成し、2回目以降は同じ画面部品を使い続けます。
function openPreview(report) {
  previewDialog.showModal();
  if (!viewer) {
    viewer = new MESCIUS.ActiveReportsJS.ReportViewer.Viewer("#viewer-host", { language: "ja" });
  }
  return viewer.open(report.definition);
}

// デザイナーの「新規作成」「開く」「保存」「名前を付けて保存」「プレビュー」をアプリの処理に接続します。
// これにより、デザイナーの標準操作から形式選択画面や Reports 用APIを利用できます。
if (!window.MESCIUS?.ActiveReportsJS?.ReportDesigner) {
  setStatus("ActiveReportsJS を読み込めません。ネットワーク接続を確認してください。", true);
} else {
  designer = new MESCIUS.ActiveReportsJS.ReportDesigner.Designer("#designer-host", { language: "ja" });
  designer.setActionHandlers({
    onCreate: async () => {
      const type = await chooseCreateType();
      if (!type) return undefined;
      try {
        const definition = type === "page"
          ? (await apiRequest("/api/templates/page-report")).definition
          : blankReport(type);
        if (type === "page") definition.Name = "新しいレポート";
        currentReportId = undefined;
        currentDocument.textContent = "新しいレポート";
        setStatus(`${type === "page" ? "ページ" : "RDL"}レポートを作成しました。`);
        return { definition, displayName: "新しいレポート" };
      } catch (error) {
        setStatus(`新規レポートを作成できませんでした: ${error.message}`, true);
        return undefined;
      }
    },
    onOpen: chooseReport,
    onSave: saveCurrent,
    onSaveAs: saveAs,
    onRender: openPreview,
  });

  // レポートパーツは、見出しや表など、何度も使う部品をまとめておく仕組みです。
  // たとえば、会社名や請求書の明細表を部品として登録すると、別のレポートでも同じ部品を使えます。
  // id は、デザイナーが部品の一覧を読み込むためにアクセスするファイルのURLです。
  // name はライブラリを内部で区別する名前、displayName はデザイナーの画面に表示する名前です。
  // このURLから取得できるのは Reports/Parts 内の登録済みファイルだけです。
  // そのため、保存したレポートやテンプレートを誤って部品として公開することはありません。
  designer.setReportPartsLibraries([
    { id: "/Reports/Parts/InvoiceParts.rdlx-json", name: "InvoiceParts", displayName: "請求書パーツ" },
    { id: "/Reports/Parts/BsParts.rdlx-json", name: "BsParts", displayName: "BSパーツ" },
  ]);

  // デザイナーでレポートに変更が加わるたびに、このイベントが通知されます。
  designer.documentChanged.register((event) => {
    // isDirty が true なら、最後に保存した状態から変更されています。
    // 画面に未保存であることを表示し、保存が必要だと利用者に伝えます。
    if (event.isDirty) setStatus("未保存の変更があります。");
  });

  // 画面を開いた直後は、空のRDLレポートを表示します。
  // 「新規作成」から別の形式が選ばれた場合は、その形式のレポートに切り替わります。
  designer.setReport({ definition: blankReport("rdl"), displayName: "新しいレポート" });
  // 初期表示に必要な準備が終わったことを、画面のステータス欄に表示します。
  setStatus("準備完了");
}

// 各ダイアログの閉じる／キャンセルボタンを押したとき、対応する画面を閉じます。
document.querySelector("#close-preview").addEventListener("click", () => previewDialog.close());
document.querySelector("#close-open").addEventListener("click", () => openDialog.close());
document.querySelector("#cancel-save").addEventListener("click", () => saveDialog.close());
