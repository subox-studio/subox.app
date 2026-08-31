#!/usr/bin/env node
/**
 * scrape-prices.mjs
 * ------------------
 * "外部の公式価格チェック" の実体。data/services.json に載っている各サー
 * ビスの公式ページ（priceCheckUrl）に実際にアクセスし、ページ本文から
 * 月額料金（円）らしき数値を抽出して data/prices.json を更新する。
 *
 * 実行方法:
 *   node scripts/scrape-prices.mjs
 *
 * 通常は .github/workflows/update-prices.yml が毎日自動実行し、変化が
 * あれば data/prices.json をコミットする。手動実行して差分を確認しても
 * よい。
 *
 * 設計方針（アプリ側 index.html の syncLivePrices() と対になる契約）:
 *   - 出力は必ず { generatedAt, items:[{id, price?, status, checkedAt}] }
 *     の形。price は status:"ok" の時だけ入れる。
 *   - 1件の取得に失敗しても他の件には影響しない（Promise.allSettled 的に
 *     1件ずつ try/catch）。
 *   - priceCheckUrl が無い（＝未調査）サービスは status:"skip" として
 *     明示し、既存の内蔵参考価格をそのまま使わせる。
 *   - ページから複数の価格らしき数値が見つかった場合は、現在の参考価格
 *     に最も近い値を採用する（プラン一覧ページなどで無関係な価格を拾う
 *     事故を減らすため）。それでも参考価格から大きく外れる場合は
 *     status:"out-of-range" として反映しない（＝安全側に倒す）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVICES_PATH = path.join(ROOT, "data", "services.json");
const OUTPUT_PATH = path.join(ROOT, "data", "prices.json");

const REQUEST_TIMEOUT_MS = 15_000;
const DELAY_BETWEEN_REQUESTS_MS = 400; // 相手サーバーに配慮して間隔を空ける
const USER_AGENT =
  "SuboxPriceBot/1.0 (+https://github.com/subox-studio/subox.app; " +
  "daily official-price check for a personal subscription-tracker app)";

// 各サービスの公式ページの本文から「月額◯円」らしき数値をすべて拾う。
// 「¥1,490」「￥1,490」「1,490円」のいずれの表記にも対応する。
const GENERIC_YEN_PATTERN = /[¥￥]\s?([\d,]{3,7})(?!\d)|([\d,]{3,7})\s?円(?!程度|割|分の)/g;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCandidates(html, customPattern) {
  const re = customPattern ? new RegExp(customPattern, "g") : GENERIC_YEN_PATTERN;
  const candidates = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1] || match[2] || match[0];
    const num = Number(String(raw).replace(/[^\d]/g, ""));
    if (Number.isFinite(num) && num > 0) candidates.push(num);
    // 無限ループ防止（lastIndexが進まないパターンを渡された場合の保険）
    if (re.lastIndex === match.index) re.lastIndex++;
  }
  return candidates;
}

function pickClosest(candidates, referencePrice) {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestDiff = Math.abs(best - referencePrice);
  for (const c of candidates) {
    const diff = Math.abs(c - referencePrice);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8"
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(service) {
  const now = new Date().toISOString();
  if (!service.priceCheckUrl) {
    return { id: service.id, status: "skip", checkedAt: now };
  }
  try {
    const html = await fetchHtml(service.priceCheckUrl);
    const candidates = extractCandidates(html, service.pattern);
    const picked = pickClosest(candidates, service.referencePrice);
    if (picked === null) {
      return { id: service.id, status: "no-match", checkedAt: now };
    }
    // 参考価格の半分未満・2.5倍超は「別プランの価格を誤って拾った」可能性
    // が高いとみなし、安全側に倒して反映しない。
    const ratio = picked / service.referencePrice;
    if (ratio < 0.5 || ratio > 2.5) {
      return { id: service.id, status: "out-of-range", checkedAt: now, foundPrice: picked };
    }
    return { id: service.id, status: "ok", price: picked, checkedAt: now };
  } catch (err) {
    return { id: service.id, status: "error", checkedAt: now, error: String(err && err.message || err) };
  }
}

async function main() {
  const services = JSON.parse(await fs.readFile(SERVICES_PATH, "utf8"));
  const items = [];
  const summary = { ok: 0, skip: 0, "no-match": 0, "out-of-range": 0, error: 0 };

  for (const service of services) {
    const result = await checkOne(service);
    items.push(result);
    summary[result.status] = (summary[result.status] || 0) + 1;
    if (service.priceCheckUrl) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    items
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log("公式価格チェック完了:", summary);
  console.log("反映(ok):", summary.ok + "/" + services.length);
}

main().catch((err) => {
  console.error("scrape-prices.mjs が異常終了しました:", err);
  process.exit(1);
});
