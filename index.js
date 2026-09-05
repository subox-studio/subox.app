/**
 * Subox - AI機能用 Firebase Cloud Functions (2nd gen)
 *
 * クライアント(index.html)から直接 api.anthropic.com を叩くと、静的サイトの
 * ソースコードにAPIキーを書くしかなく、誰でも閲覧・盗用できてしまう。
 * この関数はサーバー側（Firebaseのインフラ上）でAnthropic APIキーを
 * Secret Managerに保管し、クライアントは httpsCallable 経由でこの関数を
 * 呼び出すだけにする。
 *
 * デプロイ方法は同ディレクトリの README.md を参照。
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// firebase functions:secrets:set ANTHROPIC_API_KEY で設定する
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const VALID_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "CAD", "HKD", "KRW", "CNY"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB程度を上限に（base64換算でおよそこの文字数以下）

function extractJsonFromText(text) {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no json found in model response");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * analyzeSubscriptionImage
 * data: { imageBase64: string, mediaType: string }
 * 戻り値: { name, price, currency, url, cycle }
 */
exports.analyzeSubscriptionImage = onCall(
  {
    region: "asia-northeast1", // Firestoreと合わせておくと管理しやすい。変更する場合はクライアント側の firebase.functions(app, region) も合わせて変更すること
    secrets: [ANTHROPIC_API_KEY],
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    const { imageBase64, mediaType } = request.data || {};

    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "imageBase64 is required");
    }
    if (imageBase64.length > MAX_IMAGE_BYTES * 1.4) {
      // base64はバイナリよりおよそ4/3大きくなるため、その分の余裕を見て弾く
      throw new HttpsError("invalid-argument", "image too large");
    }
    const allowedMediaTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const safeMediaType = allowedMediaTypes.includes(mediaType) ? mediaType : "image/jpeg";

    const systemPrompt =
      "あなたはサブスクリプション管理アプリの画像解析アシスタントです。渡された画像（領収書・請求書・確認メール・サービスの申込/請求ページのスクリーンショットなど）から、サブスクリプションサービスの情報を抽出してください。" +
      " 出力は必ず次のキーを持つJSONオブジェクトのみとし、それ以外のテキスト・説明・マークダウンのコードフェンスは一切含めないでください。" +
      ` {"name": string|null（サービス名）, "price": number|null（金額の数値のみ、通貨記号やカンマは除く）, "currency": string|null（${VALID_CURRENCIES.join("/")}のいずれか）, "url": string|null（サービスの公式サイトURL。わかる場合のみ、推測が確実な場合に限る）, "cycle": "monthly"|"yearly"|null（月額か年額か分かる場合）}.` +
      " 情報が画像から読み取れない項目はnullにしてください。金額に小数がある場合はそのまま数値で出力してください。";

    let response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: safeMediaType, data: imageBase64 } },
                { type: "text", text: "この画像からサブスクリプションの情報をJSON形式で抽出してください。" },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      logger.error("anthropic fetch failed", err);
      throw new HttpsError("unavailable", "AI解析サービスに接続できませんでした");
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      logger.error("anthropic api error", response.status, bodyText);
      throw new HttpsError("internal", "AI解析サービスがエラーを返しました (" + response.status + ")");
    }

    const data = await response.json();
    const textParts = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text);

    let parsed;
    try {
      parsed = extractJsonFromText(textParts.join("\n"));
    } catch (err) {
      logger.error("failed to parse model json", err, textParts.join("\n"));
      throw new HttpsError("internal", "AI解析結果を読み取れませんでした");
    }

    // サーバー側でも軽くバリデーションしてから返す
    const name = typeof parsed.name === "string" ? parsed.name.trim() : null;
    const price =
      typeof parsed.price === "number" && !Number.isNaN(parsed.price) ? parsed.price : null;
    const currency =
      typeof parsed.currency === "string" && VALID_CURRENCIES.includes(parsed.currency.toUpperCase())
        ? parsed.currency.toUpperCase()
        : null;
    const url =
      typeof parsed.url === "string" && /^https?:\/\//.test(parsed.url.trim())
        ? parsed.url.trim()
        : null;
    const cycle = parsed.cycle === "monthly" || parsed.cycle === "yearly" ? parsed.cycle : null;

    return { name, price, currency, url, cycle };
  }
);

/**
 * プッシュ通知の定期送信・テスト送信。実装は push.js を参照（同ディレクトリに
 * 配置し、導入手順・Firestoreルールの追加・service-lookup.jsonの用意など
 * の詳細もそのファイル冒頭に記載）。
 */
exports.sendScheduledPushNotifications = require("./push").sendScheduledPushNotifications;
exports.sendTestPushNotification = require("./push").sendTestPushNotification;

/**
 * 外部の公式価格チェック（定期実行）。実装は checkPrices.js を参照（同
 * ディレクトリに配置し、導入手順・price-check-services.jsonの用意などの
 * 詳細もそのファイル冒頭に記載）。
 */
exports.checkOfficialPrices = require("./checkPrices").checkOfficialPrices;
exports.runPriceCheckNow = require("./checkPrices").runPriceCheckNow;
