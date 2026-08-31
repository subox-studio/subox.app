/**
 * scanGmailSubscriptions
 * ------------------------------------------------------------------
 * Gmailの受信トレイから「請求・領収・定期購入の確認」に該当しそうな
 * メールを検索し、その内容をAI（Anthropic API）に渡してサブスクリプ
 * ション候補（サービス名・金額・請求周期・URL）を抽出して返す
 * Firebase Cloud Functions の callable 関数。
 *
 * index.html 側（analyzeSubscriptionImage と同じ callAiFunction 経由）
 * から以下の形で呼ばれる想定：
 *
 *   const items = await callAiFunction("scanGmailSubscriptions", {
 *     accessToken: "<GoogleのOAuthアクセストークン（gmail.readonlyスコープ付き）>",
 *     days: 180
 *   });
 *
 * このファイル単体では動きません。既存の functions/index.js に
 * exports.scanGmailSubscriptions として追記し、下記の準備を行った上で
 * `firebase deploy --only functions:scanGmailSubscriptions` してください。
 *
 * ---- 事前準備（重要） ----------------------------------------------
 * 1. Google Cloud Console で「Gmail API」を有効化する
 *    （プロジェクト: subox-studio）
 * 2. 「APIとサービス」→「OAuth同意画面」で、スコープ一覧に
 *    https://www.googleapis.com/auth/gmail.readonly を追加する
 * 3. ★最重要★ gmail.readonly はGoogleの「制限付き（機密）スコープ」
 *    に該当するため、一般公開してテストユーザー以外にも使わせる場合は
 *    Googleによる「OAuthアプリ確認（審査）」が必須です。
 *    審査には、プライバシーポリシーの掲示・スコープ利用目的の説明・
 *    セキュリティ評価（CASA）が必要になるケースがあり、数週間かかる
 *    こともあります。審査が通るまでは「テストユーザー」として登録した
 *    Googleアカウント（最大100件）でのみ動作し、それ以外のユーザーは
 *    「このアプリは確認されていません」という警告画面で止まります。
 *    → 開発中・社内検証中はテストユーザー登録で進め、一般公開前に
 *      正式にOAuth確認を申請することを強く推奨します。
 * 4. functions ディレクトリで `npm install googleapis` を実行
 * 5. Anthropic APIキーは、既存の analyzeSubscriptionImage 関数が使って
 *    いるものと同じ設定（functions.config().anthropic.key や
 *    process.env.ANTHROPIC_API_KEY など、既存コードの初期化方法に合わ
 *    せてください）をそのまま利用できます。下のコードでは
 *    `getAnthropicClient()` という仮の関数にしているので、既存ファイル
 *    にある実際のクライアント初期化コードに置き換えてください。
 * ---------------------------------------------------------------------
 */

const functions = require("firebase-functions");
const { google } = require("googleapis");
// 既存の analyzeSubscriptionImage で使っているAnthropicクライアントの
// 初期化コード／importをそのまま使い回してください。ここでは仮に
// @anthropic-ai/sdk を直接使う例を示します。
const Anthropic = require("@anthropic-ai/sdk");

function getAnthropicClient() {
  // 既存コードに合わせて置き換え。例:
  // return new Anthropic({ apiKey: functions.config().anthropic.key });
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// 検索対象を「請求・領収・定期購入っぽいメール」に絞り込むクエリ。
// 日本語の件名パターンと、主要サブスク事業者からのメールの両方を拾う。
function buildGmailSearchQuery(days) {
  const subjectKeywords = [
    "領収書", "ご請求", "お支払い", "お支払明細", "定期購入", "サブスクリプション",
    "更新のお知らせ", "自動更新", "receipt", "invoice", "subscription", "renewed", "payment"
  ];
  const subjectPart = "(" + subjectKeywords.map((k) => `subject:${k}`).join(" OR ") + ")";
  return `newer_than:${days}d ${subjectPart}`;
}

// Gmail APIのmessageペイロードからプレーンテキスト本文を取り出す
// （text/plainパートを優先し、無ければsnippetにフォールバック）。
function extractPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return "";
}

exports.scanGmailSubscriptions = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    // ログイン済みユーザーのみ許可（他のcallable関数と同じ方針）
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "この機能を利用するにはログインが必要です"
      );
    }

    const accessToken = data && data.accessToken;
    if (!accessToken || typeof accessToken !== "string") {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Googleのアクセストークンが指定されていません"
      );
    }
    const days = Number.isFinite(data && data.days) ? Math.min(Math.max(data.days, 1), 365) : 180;

    // 呼び出し元のアクセストークンでGmail APIを叩く
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    let messageIds = [];
    try {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: buildGmailSearchQuery(days),
        maxResults: 40,
      });
      messageIds = (listRes.data.messages || []).map((m) => m.id);
    } catch (err) {
      console.error("Gmail messages.list failed", err);
      throw new functions.https.HttpsError(
        "internal",
        "Gmailの検索に失敗しました。アクセス許可（gmail.readonlyスコープ）を確認してください"
      );
    }

    if (!messageIds.length) {
      return { items: [] };
    }

    // 本文取得はAPI呼び出し数がかさむため、上限を設けて安全側に倒す
    const MAX_MESSAGES_TO_FETCH = 25;
    const targetIds = messageIds.slice(0, MAX_MESSAGES_TO_FETCH);

    const emailSummaries = [];
    for (const id of targetIds) {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        });
        const headers = (msgRes.data.payload && msgRes.data.payload.headers) || [];
        const subject = (headers.find((h) => h.name === "Subject") || {}).value || "";
        const from = (headers.find((h) => h.name === "From") || {}).value || "";
        const bodyText = extractPlainText(msgRes.data.payload) || msgRes.data.snippet || "";
        emailSummaries.push({
          subject,
          from,
          // AIに渡すテキストは長すぎるとコスト・精度の両面で不利なので切り詰める
          body: bodyText.slice(0, 1500),
        });
      } catch (err) {
        console.error("Gmail messages.get failed for", id, err);
        // 1件失敗しても全体は続行する
      }
    }

    if (!emailSummaries.length) {
      return { items: [] };
    }

    // AIにまとめて渡し、構造化されたサブスク候補として抽出させる
    const anthropic = getAnthropicClient();
    const prompt =
      "以下は個人の受信トレイから抽出した、請求・領収・定期購入関連の可能性があるメールの一覧です（件名・送信元・本文の一部）。" +
      "この中から実際に「定期的に繰り返し発生する支払い（サブスクリプション）」に該当するものだけを抽出し、" +
      "重複するサービスは1件にまとめてください。" +
      "出力は必ず次の形式のJSON配列のみとし、前後に説明文やMarkdownを付けないでください：\n" +
      '[{"name": "サービス名", "price": 数値（税込金額、通貨単位は含めない）, "currency": "JPY等のISO通貨コード", ' +
      '"cycle": "monthly または yearly", "url": "サービスの公式サイトURL（分かる場合のみ、無ければ空文字）", ' +
      '"sourceSnippet": "判断根拠にした本文の抜粋（40文字程度）"}]\n\n' +
      "該当するメールが1件もない場合は空配列 [] を返してください。\n\n---\n" +
      emailSummaries
        .map(
          (e, i) =>
            `[メール${i + 1}]\n件名: ${e.subject}\n送信元: ${e.from}\n本文抜粋: ${e.body}\n`
        )
        .join("\n");

    let items = [];
    try {
      const aiRes = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      });
      const text = aiRes.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      if (start !== -1 && end !== -1 && end > start) {
        items = JSON.parse(cleaned.slice(start, end + 1));
      }
    } catch (err) {
      console.error("AI parse failed", err);
      throw new functions.https.HttpsError(
        "internal",
        "メール内容の解析に失敗しました"
      );
    }

    return { items: Array.isArray(items) ? items : [] };
  });
