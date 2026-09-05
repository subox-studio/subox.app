/**
 * Subox - プッシュ通知送信用 Firebase Cloud Function (2nd gen)
 *
 * 「アプリを閉じていても届く」本格的なプッシュ通知の送信元。定期実行
 * (onSchedule) で全ユーザーを走査し、各ユーザーのFirestoreデータ
 * （users/{uid} ドキュメント。フィールド名はクライアント側のローカル
 * ストレージのキーと同じ = index.html の STORAGE_KEY 等の値そのもの）
 * から「通知すべき項目」を判定して、登録済みのFCMトークンへ送信する。
 *
 * ロジックは index.html 側の getNotifications / getTrialNotifications /
 * getCancelNotifications / getCalendarEventNotifications /
 * getTaskNotifications / getPriceChangeNotifications と同じ考え方を
 * 移植したもの（価格改定はprices/latestコレクションとservice-lookup.json
 * を使ってサーバー単独で判定できるため対応済み）。ただし以下は対象外
 * （クライアント側のAI分析・状態に依存し、サーバー単独では再現しにくい
 * ため）:
 *   - アドバイス通知 / 家計管理通知 / メンテナンスのお知らせ / アップデート
 *     のお知らせ ... 日付を軸にした「近づいたらお知らせ」ではないため、
 *     現状はアプリを開いている間の通知（sendBrowserNotifications）のみ
 *
 * ---- 事前準備 ----
 * 1. このファイルと同じディレクトリに service-lookup.json を配置する
 *    （index.html内のPOPULAR_SERVICESからid/name/aliasesだけを抜き出した
 *    もの。価格改定通知のサービス名照合に使う。POPULAR_SERVICESを更新した
 *    場合はこちらも合わせて更新すること）。
 * 2. このファイルを firebase-functions/push.js として配置し、同ディレクトリの
 *    index.js から re-export する（本リポジトリでは index.js の末尾で
 *    `exports.sendScheduledPushNotifications = require("./push").sendScheduledPushNotifications;`
 *    `exports.sendTestPushNotification = require("./push").sendTestPushNotification;`
 *    のように呼び出している）。
 * 3. `npm install firebase-admin --save`（未導入の場合）を firebase-functions
 *    ディレクトリ内で実行する。
 * 4. Firestoreのセキュリティルールに、クライアントが自分のFCMトークンを
 *    登録できるよう以下を追加する（users/{uid} 自体のルールとは別に、
 *    サブコレクションには明示的な許可が必要なため）:
 *
 *      match /users/{uid}/pushTokens/{token} {
 *        allow read, write: if request.auth != null && request.auth.uid == uid;
 *      }
 *
 * 5. Cloud Scheduler API と Cloud Functions/Firebase Cloud Messaging API を
 *    有効化した上で `firebase deploy --only functions:sendScheduledPushNotifications,functions:sendTestPushNotification`
 *    でデプロイする。
 * 6. クライアント側 (index.html) の FCM_VAPID_KEY に、Firebaseコンソールの
 *    「プロジェクトの設定」→「Cloud Messaging」で発行したVAPID公開鍵を
 *    設定する（詳細はindex.html内の該当コメントを参照）。
 *
 * ---- 対象になっている通知種別 ----
 * 更新日・トライアル終了・解約予定日・カレンダー予定・タスク期限・価格改定
 * （公式価格が変わったとみられる場合）。以下は対象外:
 *   - アドバイス通知 / 家計管理通知 / メンテナンスのお知らせ / アップデート
 *     のお知らせ ... 日付やサーバー参照データだけでは判定できない
 *     クライアント側のAI分析・状態に依存するため、現状はアプリを開いている
 *     間の通知（sendBrowserNotifications）のみ。将来的に対象を広げる場合は
 *     buildDueItemsForUser() に判定を追加していく想定。
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const SERVICE_LOOKUP_LIST = require("./service-lookup.json");

if (!admin.apps.length) admin.initializeApp();

const REGION = "asia-northeast1";

/* 価格改定通知用のサービス名照合テーブル。index.html内のPOPULAR_SERVICES
   (id/name/aliasesのみ) をそのまま抽出したもの。POPULAR_SERVICESに新しい
   サービスを追加・変更した場合、こちらのservice-lookup.jsonも合わせて
   更新しないと価格改定プッシュの対象漏れが生じる点に注意（生成方法:
   index.html内のPOPULAR_SERVICES配列から id/name/aliases だけを抜き出す）。 */
function normalizeServiceQuery(s) {
  return (s || "").toLowerCase().replace(/[\s\u3000]+/g, "");
}
const SERVICE_LOOKUP = {};
SERVICE_LOOKUP_LIST.forEach((s) => {
  [s.name].concat(s.aliases || []).forEach((k) => {
    SERVICE_LOOKUP[normalizeServiceQuery(k)] = s;
  });
});
function findKnownServiceId(name) {
  const key = normalizeServiceQuery(name);
  if (!key) return null;
  const svc = SERVICE_LOOKUP[key];
  return svc ? svc.id : null;
}

// 一度の実行であまりに多くの更新を書き込まないよう、ユーザーあたりの
// notify_pushed_v1 の保存上限（古いものから捨てる）。クライアント側にも
// 同様の実質的な上限は無いが、サーバー側は多数のユーザーを継続的に処理
// するため、肥大化を防ぐ目的で設ける。
const NOTIFY_PUSHED_MAX_ENTRIES = 500;

/* ---------- 日付ユーティリティ（クライアント側 daysUntil/todayStr と対応） ----------
   このアプリは日本語UI・JPY建てを前提としているため、「今日」はJST基準で
   固定的に計算する（Cloud Functionsの実行環境自体はUTCで動くため、単純に
   `new Date()` の年月日を使うとUTC日付になってしまう点に注意）。将来的に
   ユーザーごとのタイムゾームに対応する場合は、この関数をユーザー設定に
   応じて切り替えること。 */
function todayStrJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return (
    jst.getUTCFullYear() +
    "-" +
    String(jst.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(jst.getUTCDate()).padStart(2, "0")
  );
}
function daysUntilJST(dateStr, todayStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  const t = new Date(todayStr + "T00:00:00Z");
  if (isNaN(d.getTime()) || isNaN(t.getTime())) return null;
  return Math.round((d - t) / 86400000);
}
function fmtDateJa(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCMonth() + 1 + "月" + d.getUTCDate() + "日";
}
function yen(n) {
  return "¥" + Math.round(n || 0).toLocaleString("ja-JP");
}

function safeParseArray(json) {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}
function safeParseObject(json, fallback) {
  try {
    const v = JSON.parse(json || "null");
    return v && typeof v === "object" ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

/* ---------- 通知キー（クライアント側の notifKey 等と完全に一致させる。
   これにより、アプリを開いた時のクライアント側判定と、このCloud
   Functionによるサーバー側判定とで「既読/既送信」状態を共有できる） ---- */
function notifKey(s) { return s.id + "_" + s.renew; }
function trialNotifKey(s) { return s.id + "_trial_" + s.renew; }
function cancelNotifKey(s) { return s.id + "_cancel_" + s.cancelNoticeDate; }
function calEventNotifKey(e) { return e.id + "_calevent_" + e.date; }
function taskNotifKey(t) { return t.id + "_task_" + t.due; }
function priceChangeNotifKey(s, newPrice) { return s.id + "_pricechange_" + newPrice; }

/* ユーザー1人分のFirestoreデータから、通知すべき項目一覧を組み立てる。
   戻り値は { key, title, body }[] （すでにnotify_pushed_v1にあるものは除外済み）。 */
function buildDueItemsForUser(userData, todayStr, priceLookup) {
  const settings = safeParseObject(userData.notify_settings_v1, {});
  const enabled = settings.enabled !== false; // クライアント側のデフォルトに合わせる
  if (!enabled) return [];
  const daysBefore = typeof settings.daysBefore === "number" ? settings.daysBefore : 3;
  const calEventEnabled = settings.calEventEnabled !== false;
  const taskEnabled = settings.taskEnabled !== false;
  const priceChangeEnabled = settings.priceChangeEnabled !== false;

  const alreadyPushed = safeParseArray(userData.notify_pushed_v1);
  const subs = safeParseArray(userData.subscriptions_v2);
  const calendarEvents = safeParseArray(userData.calendar_events_v1);
  const tasks = safeParseArray(userData.tasks_v1);

  const items = [];

  subs.forEach((s) => {
    if (!s || !s.id) return;
    if (s.active && s.renew) {
      const d = daysUntilJST(s.renew, todayStr);
      if (d !== null) {
        if (s.trial) {
          if (d >= 0 && d <= daysBefore) {
            const key = trialNotifKey(s);
            if (alreadyPushed.indexOf(key) === -1) {
              items.push({
                key,
                type: "trial",
                targetId: s.id,
                title: "Subox: " + s.name + "の無料トライアルが終了します",
                body: fmtDateJa(s.renew) + "に無料トライアルが終了し、" + yen(s.price) + "の請求が始まります",
              });
            }
          }
        } else if (d >= 0 && d <= daysBefore) {
          const key = notifKey(s);
          if (alreadyPushed.indexOf(key) === -1) {
            items.push({
              key,
              type: "renew",
              targetId: s.id,
              title: "Subox: " + s.name + "の更新が近づいています",
              body: fmtDateJa(s.renew) + "に" + yen(s.price) + "の更新予定",
            });
          }
        }
      }
      if (s.cancelPlanned && s.cancelNoticeDate) {
        const dc = daysUntilJST(s.cancelNoticeDate, todayStr);
        if (dc !== null && dc <= 0) {
          const key = cancelNotifKey(s);
          if (alreadyPushed.indexOf(key) === -1) {
            items.push({
              key,
              type: "cancel",
              targetId: s.id,
              title: "Subox: " + s.name + "の解約予定日です",
              body: fmtDateJa(s.cancelNoticeDate) + "に解約予定の通知です",
            });
          }
        }
      }
    }
    // 価格改定通知: 公式価格の参照データ(prices/latestコレクション、
    // POPULAR_SERVICESと同じ考え方)と、登録済みの価格が食い違っている場合。
    // 日付を持たないため、一度通知したら同じ新価格の間は再送しない
    // (priceChangeNotifKeyに新価格を含めているため、価格がさらに変わると
    // 別のキーとして再度通知される)。
    if (priceChangeEnabled && s.active && (s.currency || "JPY") === "JPY" && priceLookup) {
      const knownId = findKnownServiceId(s.name);
      const refPrice = knownId ? priceLookup.get(knownId) : undefined;
      if (typeof refPrice === "number" && refPrice !== s.price) {
        const key = priceChangeNotifKey(s, refPrice);
        if (alreadyPushed.indexOf(key) === -1) {
          items.push({
            key,
            type: "pricechange",
            targetId: s.id,
            title: "Subox: " + s.name + "の価格が変わったようです",
            body: "登録中の" + yen(s.price) + "に対し、公式価格は" + yen(refPrice) + "のようです。アプリでご確認ください",
          });
        }
      }
    }
  });

  if (calEventEnabled) {
    calendarEvents.forEach((e) => {
      if (!e || !e.date) return;
      const d = daysUntilJST(e.date, todayStr);
      if (d === null || d < 0 || d > daysBefore) return;
      const key = calEventNotifKey(e);
      if (alreadyPushed.indexOf(key) !== -1) return;
      const memoText = (e.memo || "").trim();
      items.push({
        key,
        type: "calevent",
        targetId: e.id,
        title: "Subox: " + e.title,
        body: fmtDateJa(e.date) + (e.time ? " " + e.time : "") + "の予定です" + (memoText ? "：" + memoText : ""),
      });
    });
  }

  if (taskEnabled) {
    tasks.forEach((t) => {
      if (!t || t.done || !t.due) return;
      const d = daysUntilJST(t.due, todayStr);
      if (d === null || d > daysBefore) return;
      const key = taskNotifKey(t);
      if (alreadyPushed.indexOf(key) !== -1) return;
      const memoText = (t.memo || "").trim();
      items.push({
        key,
        type: "task",
        targetId: t.id,
        title: "Subox: " + t.title,
        body: fmtDateJa(t.due) + "が期限のタスクです" + (memoText ? "：" + memoText : ""),
      });
    });
  }

  return items;
}

/* 送信するプッシュのタイトル・本文を組み立てる。1件だけなら内容そのもの、
   複数件ならまとめた件数表示にして通知の出しすぎを避ける。1件の場合のみ
   type/targetIdを付け、通知タップ時にその項目の画面へ直接遷移できるよう
   にする（複数件の場合は通知一覧を開くだけにフォールバックする）。 */
function composeMessage(dueItems) {
  if (dueItems.length === 1) {
    return { title: dueItems[0].title, body: dueItems[0].body, type: dueItems[0].type, targetId: dueItems[0].targetId };
  }
  const first = dueItems[0];
  return {
    title: "Subox: " + dueItems.length + "件のお知らせがあります",
    body: first.title.replace(/^Subox:\s*/, "") + " ほか" + (dueItems.length - 1) + "件",
    type: null,
    targetId: null,
  };
}

/* prices/latest ドキュメントから { サービスid -> 参照価格 } のMapを組み立てる。
   ドキュメントが存在しない・想定外の形式の場合は空のMapを返し、価格改定
   通知は単にスキップされる（他の通知種別には影響しない）。 */
async function loadPriceLookup(db) {
  const map = new Map();
  try {
    const snap = await db.collection("prices").doc("latest").get();
    const data = snap.exists ? snap.data() : null;
    const list = data && Array.isArray(data.items) ? data.items : [];
    list.forEach((it) => {
      if (it && it.id && typeof it.price === "number") map.set(it.id, it.price);
    });
  } catch (e) {
    logger.error("prices/latestの読み込みに失敗しました（価格改定通知はスキップされます）", e);
  }
  return map;
}

async function pruneAndMergePushed(db, uid, newKeys) {
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const existing = safeParseArray((snap.data() || {}).notify_pushed_v1);
    const merged = existing.concat(newKeys.filter((k) => existing.indexOf(k) === -1));
    const trimmed = merged.length > NOTIFY_PUSHED_MAX_ENTRIES ? merged.slice(merged.length - NOTIFY_PUSHED_MAX_ENTRIES) : merged;
    tx.set(userRef, { notify_pushed_v1: JSON.stringify(trimmed) }, { merge: true });
  });
}

exports.sendScheduledPushNotifications = onSchedule(
  { schedule: "every 6 hours", region: REGION, timeoutSeconds: 300, memory: "256MiB" },
  async () => {
    const db = admin.firestore();
    const todayStr = todayStrJST();
    const priceLookup = await loadPriceLookup(db);

    // users/{uid}/pushTokens/{token} をcollectionGroupで横断的に取得し、
    // uidごとにトークンをまとめる。
    const tokensSnap = await db.collectionGroup("pushTokens").get();
    const tokensByUid = new Map();
    tokensSnap.forEach((doc) => {
      const uid = doc.ref.parent.parent.id;
      if (!tokensByUid.has(uid)) tokensByUid.set(uid, []);
      tokensByUid.get(uid).push(doc.id);
    });

    if (!tokensByUid.size) {
      logger.info("送信対象のプッシュトークンが登録されているユーザーはいませんでした");
      return;
    }

    let usersNotified = 0;
    for (const [uid, tokens] of tokensByUid.entries()) {
      try {
        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) continue;
        const userData = userSnap.data() || {};
        const dueItems = buildDueItemsForUser(userData, todayStr, priceLookup);
        if (!dueItems.length) continue;

        const message = composeMessage(dueItems);
        const response = await admin.messaging().sendEachForMulticast({
          tokens,
          // notificationフィールドは使わず data のみ送る。ブラウザ側で
          // 自動表示させず、必ずsw.jsのonBackgroundMessage経由で
          // アイコン・クリック時の遷移先(data.url/data.key/data.type/
          // data.targetId)を制御するため。FCMのdataペイロードは全ての値が
          // 文字列である必要があるため、null/undefinedは空文字にしておく。
          data: {
            title: message.title,
            body: message.body,
            url: "./",
            key: dueItems.length === 1 ? dueItems[0].key : "",
            type: message.type || "",
            targetId: message.targetId || "",
          },
          webpush: {
            headers: { Urgency: "normal" },
          },
        });

        // 無効化されたトークン（アンインストール・ブラウザデータ削除等）は
        // Firestoreから削除しておき、次回以降ムダな送信を試みないようにする。
        const staleTokens = [];
        response.responses.forEach((r, i) => {
          if (!r.success) {
            const code = r.error && r.error.code;
            if (
              code === "messaging/registration-token-not-registered" ||
              code === "messaging/invalid-registration-token"
            ) {
              staleTokens.push(tokens[i]);
            } else {
              logger.error("プッシュ送信に失敗しました", uid, code, r.error && r.error.message);
            }
          }
        });
        await Promise.all(
          staleTokens.map((t) => db.collection("users").doc(uid).collection("pushTokens").doc(t).delete().catch(() => {}))
        );

        await pruneAndMergePushed(db, uid, dueItems.map((it) => it.key));
        usersNotified++;
      } catch (e) {
        logger.error("ユーザーへのプッシュ通知処理でエラーが発生しました", uid, e);
      }
    }
    logger.info("プッシュ通知の定期送信が完了しました。送信対象ユーザー数: " + usersNotified);
  }
);

/**
 * sendTestPushNotification
 * ログイン中のユーザー自身に、設定確認用のテストプッシュを即時送信する
 * onCall関数。index.html側の「テスト通知を送信」ボタンから呼ばれる。
 * 戻り値: { sent: number, failed: number }
 */
exports.sendTestPushNotification = onCall(
  { region: REGION, timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です");
    }
    const uid = request.auth.uid;
    const db = admin.firestore();
    const tokensSnap = await db.collection("users").doc(uid).collection("pushTokens").get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (!tokens.length) {
      throw new HttpsError("failed-precondition", "登録されたプッシュ通知トークンがありません");
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        title: "Subox: テスト通知",
        body: "この通知が届いていれば、プッシュ通知の設定は正常です",
        url: "./",
        key: "",
        type: "",
        targetId: "",
      },
      webpush: { headers: { Urgency: "high" } },
    });

    const staleTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          staleTokens.push(tokens[i]);
        } else {
          logger.error("テスト通知の送信に失敗しました", uid, code, r.error && r.error.message);
        }
      }
    });
    await Promise.all(
      staleTokens.map((t) => db.collection("users").doc(uid).collection("pushTokens").doc(t).delete().catch(() => {}))
    );

    return { sent: response.successCount, failed: response.failureCount };
  }
);
