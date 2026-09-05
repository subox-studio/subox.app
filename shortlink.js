/**
 * Subox - 短縮URLリダイレクト用 Firebase Cloud Function (2nd gen)
 *
 * index.html側の「短縮URL」ツールがFirestore(shortlinks/{id})に
 * { url, createdAt, uid } を書き込む。この関数は、短縮URL
 * (例: https://subox-studio.web.app/s/aB3xY9) へのアクセスを受け取り、
 * Firestoreから元のURLを引いて302リダイレクトする。
 *
 * ---- 事前準備 ----
 * 1. index.js の末尾に以下を追加する:
 *      exports.shortlinkRedirect = require("./shortlink").shortlinkRedirect;
 * 2. firebase.json の "hosting" セクションに、/s/以下へのアクセスをこの
 *    関数へ振り向けるリライトルールを追加する（既存のrewritesの配列に
 *    追加。SPA用の "**" → index.html のルールより前に書くこと。書く順番
 *    を間違えると、/s/以下も先にindex.htmlへ振られてしまいリダイレクトが
 *    機能しない）:
 *
 *      "rewrites": [
 *        { "source": "/s/**", "function": "shortlinkRedirect" },
 *        { "source": "**", "destination": "/index.html" }
 *      ]
 *
 * 3. Firestoreのセキュリティルールに以下を追加する（クライアントは新規
 *    作成のみ許可し、読み取り・変更・削除は一切許可しない。読み取りは
 *    この関数がAdmin SDK経由で行うため、クライアント側の読み取り許可は
 *    不要 — 短縮元のURL一覧を誰でも見られる状態を避けるため、あえて
 *    read: falseにしている）:
 *
 *      match /shortlinks/{id} {
 *        allow read: if false;
 *        allow create: if request.auth != null
 *          && request.resource.data.uid == request.auth.uid
 *          && request.resource.data.url is string
 *          && request.resource.data.url.matches('^https?://.+')
 *          && request.resource.data.keys().hasOnly(['url','createdAt','uid']);
 *        allow update, delete: if false;
 *      }
 *
 * 4. `firebase deploy --only functions:shortlinkRedirect,hosting,firestore:rules`
 *    でデプロイする（hostingのリライト追加を反映するため、hostingも
 *    一緒にデプロイする必要がある）。
 * 5. index.html内の SHORTLINK_DOMAIN 定数が、実際にデプロイされている
 *    Firebase Hostingのドメイン（独自ドメインを使っている場合はそちら）
 *    と一致しているか確認する。
 *
 * ---- 補足 ----
 * - 短縮URLは作成後、変更・削除ができない設計（誤って共有済みのリンクが
 *   突然無効になる事故を防ぐため）。もし将来的に「無効化」機能が必要に
 *   なった場合は、ドキュメントに disabled:true のようなフィールドを
 *   追加し、この関数側でそのチェックを追加する形で拡張できる。
 * - 存在しないID・無効なURLへのアクセスは404を返す。
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

const REGION = "asia-northeast1";

exports.shortlinkRedirect = onRequest(
  { region: REGION, timeoutSeconds: 15, memory: "128MiB" },
  async (req, res) => {
    var match = (req.path || "").match(/\/s\/([A-Za-z0-9_-]+)/);
    var id = match ? match[1] : null;
    if (!id) {
      res.status(400).send("短縮URLの形式が正しくありません");
      return;
    }
    try {
      var snap = await admin.firestore().collection("shortlinks").doc(id).get();
      if (!snap.exists) {
        res.status(404).send("このリンクは見つかりませんでした（削除された、または入力に誤りがある可能性があります）");
        return;
      }
      var data = snap.data() || {};
      var url = data.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        res.status(500).send("リンク先の情報が不正です");
        return;
      }
      // キャッシュされて古いリダイレクト先が使われ続けることを避ける
      // （リンク自体は不変な設計だが、念のため）。
      res.set("Cache-Control", "no-store");
      res.redirect(302, url);
    } catch (e) {
      logger.error("短縮URLのリダイレクトに失敗しました", id, e);
      res.status(500).send("エラーが発生しました。時間をおいて再度お試しください。");
    }
  }
);
