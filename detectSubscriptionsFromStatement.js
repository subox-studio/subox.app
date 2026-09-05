/**
 * detectSubscriptionsFromStatement — Firebase Callable Function
 * ---------------------------------------------------------------
 * Given the raw text of a bank/credit-card statement (CSV or plain text,
 * as uploaded on the "明細から自動検出" page), asks Claude to identify
 * which line items look like recurring subscription charges and returns
 * them as structured candidates the client can let the person review and
 * add.
 *
 * Called from index.html via:
 *   callAiFunction("detectSubscriptionsFromStatement", { text, fileName })
 * (see runStatementScan() in the "明細から自動検出" section of index.html)
 *
 * This mirrors the same client → Cloud Function → Anthropic API shape as
 * the app's other AI features (analyzeSubscriptionImage, scanGmailSubscriptions):
 * the API key never touches the browser, only structured JSON does.
 *
 * ---------------------------------------------------------------------
 * SETUP:
 *   npm install firebase-functions firebase-admin @anthropic-ai/sdk
 *   firebase functions:config:set anthropic.key="sk-ant-..."
 *   firebase deploy --only functions:detectSubscriptionsFromStatement
 *
 * Region must match the client's firebase.functions(app, "asia-northeast1")
 * call — keep REGION below in sync if that ever changes.
 * ---------------------------------------------------------------------
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");

if (!admin.apps.length) {
  admin.initializeApp();
}

const REGION = "asia-northeast1"; // keep in sync with the client
const MAX_TEXT_LENGTH = 20000; // matches STATEMENT_MAX_TEXT_LENGTH on the client — defense in depth
const DAILY_LIMIT_PER_UID = 10; // generous server-side ceiling; the client's own 2/day is the primary UX limit

const SYSTEM_PROMPT = `あなたは家計簿アプリの明細解析アシスタントです。
銀行やクレジットカードの明細（CSVまたはプレーンテキスト）が渡されるので、
その中から「定期購読・サブスクリプションらしい支払い」だけを抽出してください。

判断のポイント:
- 同じ加盟店名で、同程度の金額が周期的（毎月・毎年など）に発生していそうなもの
- Netflix、Spotify、Amazon Prime、各種クラウド/ソフトウェアサービスなど、一般に定額課金として知られているもの
- 一度きりの買い物、コンビニ、飲食店、ATM引き出し、振込などは含めない
- 同じサービスが複数回登場する場合は1件にまとめ、直近の金額を使う

出力は必ず次のJSON形式の配列のみを返してください（前置きや説明文、コードブロック記法は一切不要）:
[
  { "name": "サービス名", "price": 1980, "currency": "JPY", "cycle": "monthly", "sourceSnippet": "明細中の該当行の抜粋（120文字以内）" }
]
- price は数値（税込・その明細に記載の通貨のまま）
- currency はISO通貨コード（不明ならJPY）
- cycle は "monthly" か "yearly" のいずれか（判断できない場合は "monthly"）
- 該当する項目が1件もなければ空配列 [] を返す`;

exports.detectSubscriptionsFromStatement = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      // Anonymous/guest sessions still get a Firebase Auth UID in this app
      // (see initAuth()/enterApp() on the client), so this only rejects
      // truly unauthenticated calls.
      throw new functions.https.HttpsError("unauthenticated", "サインインが必要です");
    }

    const text = typeof data.text === "string" ? data.text.slice(0, MAX_TEXT_LENGTH) : "";
    const fileName = typeof data.fileName === "string" ? data.fileName.slice(0, 200) : "";

    if (!text.trim()) {
      throw new functions.https.HttpsError("invalid-argument", "ファイルの中身が空です");
    }

    // Simple per-user daily counter, stored in Firestore, independent of
    // (and in addition to) the client-side counter — the client-side one
    // resets if someone just clears local storage, this one doesn't.
    const uid = context.auth.uid;
    const counterRef = admin.firestore().collection("statementScanCounters").doc(uid);
    const today = new Date().toISOString().slice(0, 10);
    await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const current = snap.exists ? snap.data() : { date: today, count: 0 };
      const count = current.date === today ? current.count : 0;
      if (count >= DAILY_LIMIT_PER_UID) {
        throw new functions.https.HttpsError(
          "resource-exhausted",
          "本日の解析回数の上限に達しました。また明日お試しください。"
        );
      }
      tx.set(counterRef, { date: today, count: count + 1 });
    });

    const config = functions.config();
    const apiKey = config.anthropic && config.anthropic.key;
    if (!apiKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        'anthropic.key function config is not set. Run: firebase functions:config:set anthropic.key="sk-ant-..."'
      );
    }

    const anthropic = new Anthropic({ apiKey });
    let raw;
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `ファイル名: ${fileName || "(不明)"}\n\n明細の内容:\n${text}`,
          },
        ],
      });
      raw = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
    } catch (e) {
      console.error("Anthropic API call failed", e);
      throw new functions.https.HttpsError("internal", "AI解析に失敗しました");
    }

    let items;
    try {
      const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      items = start !== -1 && end !== -1 ? JSON.parse(cleaned.slice(start, end + 1)) : [];
    } catch (e) {
      console.error("Failed to parse model output as JSON", raw, e);
      items = [];
    }
    if (!Array.isArray(items)) items = [];

    // Defense in depth: re-validate/clip shape server-side too, even though
    // the client also sanitizes each field before displaying it.
    const cleanedItems = items
      .filter((it) => it && typeof it.name === "string" && it.name.trim())
      .slice(0, 30)
      .map((it) => ({
        name: it.name.trim().slice(0, 100),
        price: typeof it.price === "number" && !isNaN(it.price) ? it.price : 0,
        currency: typeof it.currency === "string" ? it.currency.trim().slice(0, 10).toUpperCase() : "JPY",
        cycle: it.cycle === "yearly" ? "yearly" : "monthly",
        sourceSnippet: typeof it.sourceSnippet === "string" ? it.sourceSnippet.slice(0, 120) : "",
      }));

    return { items: cleanedItems };
  });
