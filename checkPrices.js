/**
 * Subox - 外部の公式価格チェック用 Firebase Cloud Function (2nd gen)
 *
 * アプリ内蔵の参考価格（POPULAR_SERVICES）は手入力のスナップショットであり、
 * 実際のサービスが値上げ・値下げしても自動では追従しない。この関数は
 * 定期実行され、Claude（Anthropic API）にWeb検索ツールを使わせて各サービスの
 * 現在の公式価格（日本向け・円建て）を調べ、結果を Firestore の
 * prices/latest ドキュメントへまとめて保存する。
 *
 * index.html側の syncLivePrices() は prices/latest を読みに行き、見つかれば
 * 「〇件の公式価格を反映済み」と表示するようになる（見つからない/未設定の
 * 間は「外部の公式価格チェックは未設定です」と表示される — これが今回
 * 解消したい状態）。
 *
 * ---- 事前準備 ----
 * 1. このファイルと同じディレクトリに price-check-services.json を配置する
 *    （index.html内のPOPULAR_SERVICESからid/name/domain/price/categoryだけ
 *    を抜き出したもの。POPULAR_SERVICESを更新した場合はこちらも合わせて
 *    更新すること。生成方法は同ディレクトリのservice-lookup.jsonと同様）。
 * 2. index.js と同じ ANTHROPIC_API_KEY シークレットを使う
 *    （既に analyzeSubscriptionImage 用に設定済みならそのまま使い回せる。
 *    未設定なら `firebase functions:secrets:set ANTHROPIC_API_KEY` で設定）。
 * 3. `npm install firebase-admin --save`（未導入の場合）を firebase-functions
 *    ディレクトリ内で実行する。
 * 4. index.js の末尾に以下を追加する:
 *      exports.checkOfficialPrices = require("./checkPrices").checkOfficialPrices;
 * 5. Firestoreのセキュリティルールで prices/{doc} が誰でも読める設定に
 *    なっていることを確認する（index.html側の想定と同じ。既にpush.js導入時
 *    点で読み取り公開になっている前提。書き込みはAdmin SDK経由のみなので
 *    クライアントに書き込み権限を与える必要はない）。
 * 6. Cloud Scheduler APIを有効化した上で
 *    `firebase deploy --only functions:checkOfficialPrices` でデプロイする。
 *
 * ---- コストと実行時間について ----
 * 197件のサービスをWeb検索付きでチェックするため、実行のたびに197回分の
 * Anthropic APIコール（+検索コスト）が発生する。既定では「毎週月曜3時」に
 * 1回だけ実行するようにしてあり、頻度を上げるとコストも比例して増える点に
 * 注意。CONCURRENCY（同時実行数）を上げると実行時間は短縮できるが、
 * レートリミットに当たりやすくなる。まずは既定値のまま様子を見て、
 * 必要に応じて schedule / CONCURRENCY / 対象件数 を調整すること。
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const PRICE_CHECK_SERVICES = require("./price-check-services.json");

if (!admin.apps.length) admin.initializeApp();

const REGION = "asia-northeast1";
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// 同時に処理するサービス数。上げすぎるとAnthropic APIのレートリミットに
// 当たりやすくなるため、様子を見ながら調整すること。
const CONCURRENCY = 5;
// 1件あたりのAPI呼び出しタイムアウト（ミリ秒）。Web検索を伴うため通常の
// チャットより時間がかかることがある。
const PER_ITEM_TIMEOUT_MS = 45000;

function extractJsonFromText(text) {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no json found in model response");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* サービス1件について、Claude + Web検索ツールで現在の公式価格（日本向け・
   円建て、月額）を調べる。取得できなかった/信頼度が低い場合は
   { status: "unknown" } を返し、呼び出し側は既存の内蔵価格を維持する
   （＝間違った価格で上書きしてしまうより、変更しない方が安全なため）。 */
async function checkOnePrice(svc, apiKey) {
  const systemPrompt =
    "あなたはサブスクリプションサービスの料金調査アシスタントです。" +
    "指定されたサービスの、日本向け個人プランの現在の月額料金（円、税込目安でよい）をWeb検索で確認してください。" +
    " 年額プランしか無い場合は月額換算(年額/12、四捨五入)してください。" +
    " 複数プランがある場合は、最も基本的な単一ユーザー向けプランを採用してください。" +
    " 出力は必ず次のキーを持つJSONオブジェクトのみとし、それ以外のテキスト・説明・マークダウンのコードフェンスは一切含めないでください。" +
    ' {"price": number|null（月額円、確認できなければnull）, "confidence": "high"|"low"（公式サイト等の一次情報で確認できたらhigh、伝聞や古い情報しか見つからない場合はlow）}。';

  const userText =
    "サービス名: " + svc.name +
    (svc.domain ? "\n公式サイトのドメイン: " + svc.domain : "") +
    "\nアプリに現在登録されている参考価格（古い可能性があります）: 月額" + svc.price + "円" +
    "\n現在の公式の月額料金を調べてJSONで回答してください。";

  let response;
  try {
    response = await withTimeout(
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: "user", content: userText }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }),
      PER_ITEM_TIMEOUT_MS
    );
  } catch (e) {
    return { id: svc.id, status: "unknown", reason: "fetch-failed: " + e.message };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { id: svc.id, status: "unknown", reason: "http-" + response.status + ": " + bodyText.slice(0, 200) };
  }

  const data = await response.json();
  // web_search使用時はtext以外のブロック(server_tool_use/web_search_tool_result等)
  // も混ざるため、text型のブロックだけを結合して読む。
  const textParts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);

  let parsed;
  try {
    parsed = extractJsonFromText(textParts.join("\n"));
  } catch (e) {
    return { id: svc.id, status: "unknown", reason: "parse-failed" };
  }

  const price = typeof parsed.price === "number" && !Number.isNaN(parsed.price) && parsed.price > 0 ? Math.round(parsed.price) : null;
  const confidence = parsed.confidence === "high" ? "high" : "low";
  if (price === null || confidence !== "high") {
    return { id: svc.id, status: "unknown" };
  }
  return { id: svc.id, status: "ok", price };
}

async function runInBatches(items, concurrency, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

exports.checkOfficialPrices = onSchedule(
  {
    schedule: "every monday 03:00",
    timeZone: "Asia/Tokyo",
    region: REGION,
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const apiKey = ANTHROPIC_API_KEY.value();
    const generatedAt = new Date().toISOString();

    logger.info("公式価格チェックを開始します。対象件数: " + PRICE_CHECK_SERVICES.length);

    const results = await runInBatches(PRICE_CHECK_SERVICES, CONCURRENCY, (svc) => checkOnePrice(svc, apiKey));

    const items = results.map((r) => ({
      id: r.id,
      status: r.status,
      price: r.status === "ok" ? r.price : null,
      checkedAt: generatedAt,
    }));

    const okCount = items.filter((it) => it.status === "ok").length;
    logger.info("公式価格チェックが完了しました。確認できた件数: " + okCount + " / " + items.length);
    results.forEach((r) => {
      if (r.status === "unknown" && r.reason) logger.info("価格未確認: " + r.id + " (" + r.reason + ")");
    });

    await admin.firestore().collection("prices").doc("latest").set({
      generatedAt,
      items,
    });
  }
);
