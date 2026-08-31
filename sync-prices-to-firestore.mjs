#!/usr/bin/env node
/**
 * sync-prices-to-firestore.mjs
 *
 * Pushes the JSON produced by scripts/scrape-prices.mjs into Firestore at
 * prices/latest, so the app (see applyLivePrices/fetchPricesFromFirestore
 * in index.html) can read live reference prices from the cloud instead of
 * (or in addition to) the static data/prices.json file.
 *
 * This is intentionally a separate, small script rather than a change to
 * scrape-prices.mjs itself: scrape-prices.mjs's job is "find the current
 * price for each service"; this script's job is "publish whatever it found
 * to Firestore". Keeping them separate means scrape-prices.mjs doesn't need
 * Firebase Admin credentials at all, and this script doesn't need to know
 * anything about how prices were scraped — it just reads the JSON file and
 * uploads it verbatim, so the two stay decoupled and each stays easy to
 * test on its own.
 *
 * Usage:
 *   node scripts/sync-prices-to-firestore.mjs [path-to-prices.json]
 *   (defaults to data/prices.json if no path is given)
 *
 * Requires:
 *   - the "firebase-admin" package (npm install firebase-admin)
 *   - a FIREBASE_SERVICE_ACCOUNT env var containing the full JSON contents
 *     of a Firebase service account key with Firestore write access
 *     (Firebase Console -> Project Settings -> Service Accounts ->
 *     Generate new private key). In GitHub Actions this should be stored
 *     as a repository secret and passed in via `env:`, never committed.
 */

import { readFile } from "node:fs/promises";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

async function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
    process.exit(1);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (e) {
    console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message);
    process.exit(1);
  }

  const pricesPath = process.argv[2] || "data/prices.json";
  let json;
  try {
    const raw = await readFile(pricesPath, "utf8");
    json = JSON.parse(raw);
  } catch (e) {
    console.error(`Could not read/parse ${pricesPath}:`, e.message);
    process.exit(1);
  }

  if (!json || !Array.isArray(json.items)) {
    console.error(`${pricesPath} doesn't look like a valid prices file (missing "items" array).`);
    process.exit(1);
  }

  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  // Overwrite (not merge) so a service removed from a later scrape doesn't
  // linger forever in the cloud doc as stale data.
  await db.collection("prices").doc("latest").set(json, { merge: false });

  const okCount = json.items.filter((i) => i && i.status === "ok").length;
  console.log(
    `Wrote ${json.items.length} items (${okCount} ok) to Firestore prices/latest.` +
      (json.generatedAt ? ` generatedAt=${json.generatedAt}` : "")
  );
}

main().catch((e) => {
  console.error("Unexpected failure:", e);
  process.exit(1);
});
