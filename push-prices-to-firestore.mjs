#!/usr/bin/env node
/**
 * scripts/push-prices-to-firestore.mjs
 *
 * scripts/scrape-prices.mjs が生成した data/prices.json を、Firestore の
 * prices/latest ドキュメントにも書き込む（任意・オプション）。
 *
 * index.html の syncLivePrices() は「まず Firestore の prices/latest を
 * 見て、無ければ data/prices.json にフォールバックする」という順序で
 * 価格を取得するので、これを実行しておくと GitHub Pages の再デプロイを
 * 待たずに（Firestoreの反映は即時、静的JSONはリポジトリへのコミット後の
 * 配信を待つ必要がある）アプリ側に最新価格が届くようになる。実行しなくても
 * data/prices.json 経由でアプリは動作するので必須ではない。
 *
 * 事前準備:
 * 1. Firebaseコンソール → プロジェクトの設定 → サービスアカウント →
 *    「新しい秘密鍵の生成」でJSON鍵をダウンロードする
 * 2. その中身をそのままGitHub Secretsに `FIREBASE_SERVICE_ACCOUNT` として
 *    登録する（.github/workflows/update-prices.yml 側のコメントアウトを
 *    外して有効化する）
 * 3. ローカルで試す場合は環境変数 FIREBASE_SERVICE_ACCOUNT にJSON鍵の
 *    中身（文字列）をセットして実行する:
 *      FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)" \
 *        node scripts/push-prices-to-firestore.mjs
 *
 * 依存パッケージ: firebase-admin（あらかじめ `npm install firebase-admin`
 * が必要。package.json に追加しておくこと）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error(
      "[push-prices-to-firestore] FIREBASE_SERVICE_ACCOUNT is not set. " +
        "Skipping Firestore push (this script is optional)."
    );
    process.exitCode = 1;
    return;
  }

  const dataPath = path.join(REPO_ROOT, "data", "prices.json");
  const json = JSON.parse(await fs.readFile(dataPath, "utf8"));

  // firebase-admin は事前に `npm install firebase-admin` しておくこと
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  const serviceAccount = JSON.parse(raw);
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  const db = getFirestore();

  await db.collection("prices").doc("latest").set(json, { merge: false });
  console.log(
    `[push-prices-to-firestore] wrote ${json.items.length} item(s) to prices/latest`
  );
}

main().catch((err) => {
  console.error("[push-prices-to-firestore] fatal error:", err);
  process.exitCode = 1;
});
