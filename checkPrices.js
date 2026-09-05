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
 *      exports.runPriceCheckNow = require("./checkPrices").runPriceCheckNow;
 * 5. Firestoreのセキュリティルールで prices/{doc} が誰でも読める設定に
 *    なっていることを確認する（index.html側の想定と同じ。既にpush.js導入時
 *    点で読み取り公開になっている前提。書き込みはAdmin SDK経由のみなので
 *    クライアントに書き込み権限を与える必要はない）。
 * 6. 手動実行（runPriceCheckNow）用の鍵を設定する:
 *      firebase functions:secrets:set PRICE_CHECK_ADMIN_KEY
 *    （長くランダムな文字列を推奨。忘れずに控えておくこと）
 * 7. Cloud Scheduler APIを有効化した上で
 *    `firebase deploy --only functions:checkOfficialPrices,functions:runPriceCheckNow`
 *    でデプロイする。
 * 8. デプロイ直後に、次の月曜を待たず今すぐ試したい場合は
 *    runPriceCheckNow のコメント内にある呼び出し方を参照して手動実行する。
 *
 * ---- コストと実行時間について ----
 * 197件のサービスをWeb検索付きでチェックするため、実行のたびに197回分の
 * Anthropic APIコール（+検索コスト）が発生する。既定では「毎週月曜3時」に
 * 1回だけ実行するようにしてあり、頻度を上げるとコストも比例して増える点に
 * 注意。CONCURRENCY（同時実行数）を上げると実行時間は短縮できるが、
 * レートリミットに当たりやすくなる。まずは既定値のまま様子を見て、
 * 必要に応じて schedule / CONCURRENCY / 対象件数 を調整すること。
 *
 * 197件をWeb検索付きで1件ずつ確認するため、全体の実行には数分〜十数分
 * かかることがある。そのため、バッチ（CONCURRENCY件ずつ）処理が終わる
 * たびに、その時点までの結果をFirestoreへ書き込むようにしている
 * （最後に一度だけ書き込む方式だと、タイムアウトや予期せぬエラーで処理が
 * 途中終了した場合に何も保存されないまま終わってしまうため）。処理が
 * 全て終わるまで待たなくても、実行開始から数十秒〜数分後には一部の
 * サービスの価格が反映され始める。
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
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

/* スケジュール実行・手動トリガーの両方から呼ばれる本体処理。 */
async function runPriceCheck() {
  const apiKey = ANTHROPIC_API_KEY.value();
  const generatedAt = new Date().toISOString();
  const docRef = admin.firestore().collection("prices").doc("latest");

  logger.info("公式価格チェックを開始します。対象件数: " + PRICE_CHECK_SERVICES.length);

  // items をバッチ処理の途中経過も含めて保持し、バッチが終わるたびに
  // Firestoreへ書き込む。こうすることで、途中でタイムアウト/エラーに
  // なっても、それまでに確認できた分は無駄にならず反映される。
  const itemsById = {};
  let processedCount = 0;
  const startedAt = Date.now();

  for (let i = 0; i < PRICE_CHECK_SERVICES.length; i += CONCURRENCY) {
    const batch = PRICE_CHECK_SERVICES.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((svc) => checkOnePrice(svc, apiKey)));

    batchResults.forEach((r) => {
      itemsById[r.id] = {
        id: r.id,
        status: r.status,
        price: r.status === "ok" ? r.price : null,
        checkedAt: generatedAt,
      };
      if (r.status === "unknown" && r.reason) logger.info("価格未確認: " + r.id + " (" + r.reason + ")");
    });
    processedCount += batch.length;

    try {
      await docRef.set({
        generatedAt,
        items: Object.values(itemsById),
        // 全件処理し終わる前の中間状態かどうかをクライアント側の判断材料
        // として残しておく（現状クライアントは見ていないが、将来的な
        // デバッグや「更新中」表示の拡張に使える）。
        complete: processedCount >= PRICE_CHECK_SERVICES.length,
      });
    } catch (e) {
      logger.error("Firestoreへの中間保存に失敗しました（次のバッチで再試行）", e);
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    logger.info("進捗: " + processedCount + "/" + PRICE_CHECK_SERVICES.length + "件処理済み（経過" + elapsedSec + "秒）");
  }

  const finalItems = Object.values(itemsById);
  const okCount = finalItems.filter((it) => it.status === "ok").length;
  logger.info("公式価格チェックが完了しました。確認できた件数: " + okCount + " / " + finalItems.length);
  return { total: finalItems.length, ok: okCount };
}

exports.checkOfficialPrices = onSchedule(
  {
    schedule: "every monday 03:00",
    timeZone: "Asia/Tokyo",
    region: REGION,
    secrets: [ANTHROPIC_API_KEY],
    // 197件 ÷ CONCURRENCY件ずつ、Web検索を伴うAPI呼び出しを繰り返すため、
    // 9分(540秒)では全件を処理しきれずタイムアウトすることがあった
    // （タイムアウトすると、最後にまとめて保存する方式では何も保存され
    // ないまま終了してしまっていた）。2nd genの上限である60分まで延長し、
    // かつ下のメイン処理でバッチごとに逐次保存するよう変更している。
    timeoutSeconds: 3600,
    memory: "512MiB",
  },
  runPriceCheck
);

/**
 * runPriceCheckNow
 * 手動実行用のHTTPSトリガー。デプロイ直後の動作確認や、次の定期実行
 * （毎週月曜3時）を待たずに今すぐ試したいときに使う。
 *
 * 呼び出し方（ブラウザで直接開くかcurlで叩く。デプロイ後にログへ表示
 * される実際のURLと、firebase functions:secrets:set PRICE_CHECK_ADMIN_KEY
 * で設定した値を使う）:
 *   https://<region>-<project>.cloudfunctions.net/runPriceCheckNow?key=<PRICE_CHECK_ADMIN_KEY>
 *
 * 認証の仕組み: Firebase Authのログインを介さず、誰でも知っている実行用
 * URLを叩けるとコスト（Anthropic API課金）を勝手に消費されてしまうため、
 * 事前に決めた鍵をクエリパラメータで照合する簡易的な保護をかけている。
 * `firebase functions:secrets:set PRICE_CHECK_ADMIN_KEY` で好きな値
 * （長くランダムな文字列を推奨）を設定してから使うこと。
 * 実行には数分〜十数分かかるため、リクエストがタイムアウトしても処理は
 * バックグラウンドで継続し、Firestoreには逐次保存される
 * （進捗はCloud Functionsのログで確認できる）。
 */
const PRICE_CHECK_ADMIN_KEY = defineSecret("PRICE_CHECK_ADMIN_KEY");
exports.runPriceCheckNow = onRequest(
  {
    region: REGION,
    secrets: [ANTHROPIC_API_KEY, PRICE_CHECK_ADMIN_KEY],
    timeoutSeconds: 3600,
    memory: "512MiB",
  },
  async (req, res) => {
    if (req.query.key !== PRICE_CHECK_ADMIN_KEY.value()) {
      res.status(403).send("forbidden");
      return;
    }
    res.status(202).send("価格チェックを開始しました。進捗はCloud Functionsのログで確認してください。数分〜十数分かかります。");
    try {
      await runPriceCheck();
    } catch (e) {
      logger.error("手動実行中にエラーが発生しました", e);
    }
  }
);
