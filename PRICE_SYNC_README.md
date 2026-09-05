# 公式価格の自動チェック（スクレイピング/API連携）セットアップ

## 前提：クライアント側の受け口はすでに存在していた

`index.html` には、実は **すでに「外部から取得した価格を読み込む仕組み」自体は実装済み** でした（`syncLivePrices()` 周り、`index.html` 内 `LIVE_PRICE_SYNC` の箇所）。

- 起動時（と1時間ごと）に、
  1. Firestore の `prices/latest` ドキュメント → なければ
  2. `data/prices.json`（静的ファイル）
  の順で「公式価格チェック結果」を探しに行く
- 見つかった価格を `POPULAR_SERVICES` に上書きパッチする
- `findKnownService()` / 価格改定通知（`getPriceChangeNotifications`）/ 自動更新（`runAutoPriceChangeApply`）はすべて `POPULAR_SERVICES` を参照しているので、**この2つのファイルさえ用意すれば、コード変更なしに「公式価格が変わったら通知・自動更新」が本物の外部データで動く**ようになっていました。

ただし、実際に外部サイトへアクセスして価格を取得する「発信側」（`data/prices.json` を作る処理そのもの）は存在しなかったため、今回そこを実装しました。

## 追加したファイル

| ファイル | 役割 |
|---|---|
| `scripts/scrape-prices.mjs` | 対象サービスの公式ページにアクセスし、価格を抽出して `data/prices.json` を生成する本体 |
| `.github/workflows/update-prices.yml` | 上記スクリプトを定期実行（デフォルト毎日1回）し、変更があれば自動コミットするGitHub Actions |
| `scripts/push-prices-to-firestore.mjs` | （任意）生成した価格をFirestoreの `prices/latest` にも即時反映するスクリプト |
| `data/prices.json` | 生成物のサンプル（現状は空。下記の設定をしないと空のまま） |
| `package.json` | 上記スクリプトの依存関係定義 |
| `index.html` の一部 | Firestoreルールのコメントを更新／設定画面に「参考価格の最終更新」ステータス表示を追加 |

## 使い始める手順

1. **チェック対象を追加する** — `scripts/scrape-prices.mjs` 内の `PRICE_SOURCES` 配列に、実際にチェックしたいサービスを追加します。`index.html` の `POPULAR_SERVICES` と同じ `id` を使ってください。
   - サイトが構造化データ（schema.org の `Offer.price`）を埋め込んでいれば `type: "jsonld"` が一番安定します。
   - なければ `type: "regex"` で価格文字列を正規表現抽出しますが、サイトの見た目が変わると壊れやすいので、追加時に必ず実際のページで動作確認してください。
   - **重要**: 対象サイトの利用規約・`robots.txt` を必ず確認し、自動アクセスが禁止・制限されていないか事前にチェックしてください。公式の価格APIがあるサービスは、スクレイピングより優先してください。
2. **ローカルで試す**: `npm install`（`push-prices` を使わないなら不要）→ `node scripts/scrape-prices.mjs` → `data/prices.json` の中身を確認。
3. **GitHub Actions を有効化する**: `.github/workflows/update-prices.yml` をリポジトリに置くだけで、デフォルト設定（毎日06:00 JST）で自動実行されます。Actionsタブから手動実行（`workflow_dispatch`）も可能です。
4. **（任意）Firestoreにも即時反映したい場合**:
   - Firebaseコンソールでサービスアカウントの秘密鍵を発行し、リポジトリのSecretsに `FIREBASE_SERVICE_ACCOUNT` として登録
   - `.github/workflows/update-prices.yml` 末尾のコメントアウトを解除
   - Firestoreのルールに `prices/{doc}` の公開読み取りルールを追加（`index.html` 冒頭のFirebaseセットアップ手順コメントに追記済みの内容を参照）

## 動作確認方法

設定 → 通知設定 の「🔄 参考価格の最終更新」に、最終反映日時・件数が表示されます（今回追加した表示）。`data/prices.json` が空のままだと「外部の公式価格チェックは未設定です」と表示され、アプリ内蔵の参考価格のみが使われます。

## 技術的な限界（正直な注意点）

- **「リアルタイム」ではなく「定期チェック」です**。GitHub Actionsの実行間隔（デフォルト1日1回）＋アプリ側の再取得間隔（1時間ごと）の範囲でしか更新されません。本当の意味での即時検知には、各サービス公式の価格変更Webhook等が必要ですが、一般に一般消費者向けサブスクでそうしたAPIはほぼ提供されていません。
- **JavaScriptで描画される価格ページには対応していません**。今回の実装は「静的HTML取得 + 構造化データ/正規表現」なので、価格がクライアントサイドJSで後から描画されるサイトでは取得できません。その場合はPuppeteer/Playwrightなどヘッドレスブラウザへの切り替えが必要で、実行コスト・複雑さが増します。
- **サイト構造の変化に弱いです**。各サービスの価格ページのマークアップが変わるとその項目は `status: "not_found"` や `"error"` になります（`applyLivePrices()` 側は `status !== "ok"` の項目を無視するので、アプリが壊れることはなく、単に「その分は静的な内蔵価格のまま」になります）。定期的な見直しが前提の仕組みです。
- **法的・利用規約上の配慮が必要です**。スクレイピング可否はサービスごとに異なります。今回は「どのサービスをチェックするか」を明示的な設定（`PRICE_SOURCES`）にして全件自動化しない設計にしていますが、実際に対象へ追加する前に必ず各サービスの利用規約を確認してください。
