/*
 * Subox Service Worker
 * オフラインでもアプリの見た目（シェル）を表示できるように、
 * 主要ファイルをキャッシュする。ユーザーデータは window.storage
 * (localStorage ベース) に保存されるため、このSWはキャッシュしない。
 *
 * v1.5.0でプッシュ通知関連の機能を追加:
 *   1) Firebase Cloud Messaging (FCM) のバックグラウンド受信
 *      -> アプリを閉じていても、サーバー（Cloud Functions）から送られた
 *         プッシュを受け取ってOS通知を表示する「本格的な」プッシュ通知。
 *         クライアント側の設定は index.html 内の FCM_VAPID_KEY 付近を参照。
 *   2) Periodic Background Sync / Background Sync によるローカル通知
 *      -> サーバー側の設定（Firebaseログイン等）が無くても、対応ブラウザ・
 *         インストール済みPWAであればベストエフォートで「アプリを閉じて
 *         いても定期的にチェックして通知する」動作をする。index.html側で
 *         IndexedDB (subox-notif-db) に書き出された予定一覧を、このSWが
 *         起こされた際に読み、期限が来ていて未表示のものだけ通知する。
 *         対応ブラウザが限られる（主にAndroid ChromeでインストールしたPWA）
 *         ため、1)を補完するフォールバック的な位置づけ。
 */
const CACHE_VERSION = "subox-cache-v1.5.0";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for the HTML shell so users get updates promptly,
  // falling back to cache when offline.
  if (event.request.mode === "navigate" || url.pathname.endsWith("index.html")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});

/* ==================== プッシュ通知: 1) Firebase Cloud Messaging ====================
 * index.html の firebaseConfig と同じ値をここに複製している。これらは公開用の
 * クライアント設定であり秘密情報ではない（Firestore/Authのアクセス制御は
 * セキュリティルール側で行われる）ため、複製しても問題ない。SWはページの
 * <script>を読み込めないため、この方法が必要になる。
 *
 * VAPID公開鍵の発行・設定手順は index.html 内の FCM_VAPID_KEY 付近のコメント
 * を参照。firebaseConfigやVAPID鍵が未設定/プレースホルダーのままの場合でも
 * importScripts自体は失敗しないため、try/catchで囲み、万一失敗しても上記の
 * オフラインキャッシュ機能には影響しないようにしている。
 */
try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js"
  );

  firebase.initializeApp({
    apiKey: "AIzaSyAapuIl7MOfX8ZKAswzadK0J9z_JgMddSw",
    authDomain: "subox-studio.firebaseapp.com",
    projectId: "subox-studio",
    storageBucket: "subox-studio.firebasestorage.app",
    messagingSenderId: "643786067659",
    appId: "1:643786067659:web:5c29df9c6105c10b44954e"
  });

  const messaging = firebase.messaging();

  // Cloud Functions側（firebase-functions/push.js）は data ペイロードのみを
  // 使って送信する想定（notification フィールドは使わない）。これは、
  // notification フィールドがあるとブラウザがSWを経由せず自動でOS通知を
  // 出してしまい、アプリ内の既読管理や通知クリック時の遷移(data.url等)と
  // 連携できなくなるため。ここでは両方に念のため対応しておく。
  messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    const notif = payload.notification || {};
    const title = data.title || notif.title || "Subox";
    const body = data.body || notif.body || "";
    const key = data.key || null;
    self.registration.showNotification(title, {
      body: body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: key || undefined,
      data: { url: data.url || "./", key: key, targetType: data.type || null, targetId: data.targetId || null }
    });
  });
} catch (e) {
  // Firebase Messagingの読み込みに失敗（オフライン時の初回インストール、
  // 未設定のデプロイ、gstatic.comへの通信がブロックされている環境など）。
  // 通常のオフラインキャッシュ機能には影響しない。
}

/* ---- 通知クリック時: 既に開いているタブがあればそこへフォーカスして
   ページ遷移を伝え、無ければ新しいウィンドウ/タブでアプリを開く。 ---- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (let i = 0; i < list.length; i++) {
        const client = list[i];
        if ("focus" in client) {
          try {
            client.postMessage({ type: "subox-notification-click", url: targetUrl, key: data.key || null, targetType: data.targetType || null, targetId: data.targetId || null });
          } catch (e) {}
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

/* ==================== プッシュ通知: 2) ローカル定期チェック（フォールバック） ====================
 * index.html 側で、通知対象（更新日が近いサブスク・カレンダーの予定・
 * タスクの期限など）をIndexedDB「subox-notif-db」の "schedule" ストアへ
 * { title, body, dueDate(YYYY-MM-DD) } の形で書き出している
 * (syncNotifScheduleForServiceWorker() 関数、renderNotifications() の
 * たびに更新)。
 *
 * このSWがperiodicsync/syncイベントで起こされたタイミングで dueDate が
 * 今日以前になっていて、まだ表示していない ("shown" ストアに記録が無い)
 * ものだけを通知として表示する。ログインやFirebaseの設定が一切無くても
 * 動くが、Periodic Background Syncのブラウザ対応状況（主にAndroid Chrome
 * のインストール済みPWAのみ）と、OS/ブラウザ側の判断（バッテリーや利用
 * 頻度など）により、確実に定期実行される保証はないベストエフォートの
 * 仕組みである点に注意。
 */
const NOTIF_DB_NAME = "subox-notif-db";
const NOTIF_DB_VERSION = 1;

function openNotifDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTIF_DB_NAME, NOTIF_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("schedule")) db.createObjectStore("schedule");
      if (!db.objectStoreNames.contains("shown")) db.createObjectStore("shown");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAllWithKeys(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const keys = [];
    const values = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        keys.push(cursor.key);
        values.push(cursor.value);
        cursor.continue();
      } else {
        resolve({ keys, values });
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

function idbPut(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// index.html側のtodayStr計算 (TODAY = new Date(y,m,d)を"YYYY-MM-DD"化) と
// 同じ考え方で、端末のローカル日付を求める。DateのgetFullYear/getMonth/
// getDate はUTCではなく端末のタイムゾーンを反映するため、SW内で呼んでも
// ページ側と同じ「今日」の判定になる。
function localTodayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function checkLocalNotifSchedule() {
  try {
    const db = await openNotifDb();
    const schedule = await idbGetAllWithKeys(db, "schedule");
    const shown = await idbGetAllWithKeys(db, "shown");
    const shownKeys = shown.keys;
    const todayStr = localTodayStr();
    for (let i = 0; i < schedule.keys.length; i++) {
      const key = schedule.keys[i];
      const item = schedule.values[i];
      if (shownKeys.indexOf(key) !== -1) continue;
      if (!item || !item.dueDate) continue;
      if (item.dueDate > todayStr) continue; // まだ先の予定
      try {
        await self.registration.showNotification(item.title || "Subox", {
          body: item.body || "",
          icon: "./icon-192.png",
          badge: "./icon-192.png",
          tag: key,
          data: { url: "./", key: key, targetType: item.type || null, targetId: item.targetId || null }
        });
      } catch (e) { /* この端末で通知表示自体が失敗しても他の項目の処理は続ける */ }
      await idbPut(db, "shown", key, Date.now());
    }
  } catch (e) {
    // IndexedDB未対応、あるいはまだページ側から一度もスケジュールが
    // 書き込まれていない場合など。失敗してもアプリ全体には影響しない。
  }
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "subox-notif-check") event.waitUntil(checkLocalNotifSchedule());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "subox-notif-check") event.waitUntil(checkLocalNotifSchedule());
});
