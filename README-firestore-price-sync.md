# 価格データをFirestoreにも公開する仕組み

index.html 側の `fetchPricesFromFirestore()` は `prices/latest` ドキュメントを読みに
行きますが、そのドキュメントを実際に**書き込む**側は今回新たに用意した以下の3点です。
（`.github/workflows/update-prices.yml` と `scripts/scrape-prices.mjs` の実物は今回
アップロードされていないため、それらを直接編集する代わりに、既存の仕組みに後付けできる
独立したスクリプトとして渡しています。）

## 追加したファイル

1. **`scripts/sync-prices-to-firestore.mjs`**
   `data/prices.json`（＝ `scrape-prices.mjs` が生成する既存のファイル）を読み込み、
   Firebase Admin SDK 経由で Firestore の `prices/latest` にそのまま書き込みます。
   スクレイピング処理自体には一切手を加えていません。

2. **`firestore-rules-prices-snippet.txt`**
   既存の `firestore.rules` に追加する断片。`prices/{docId}` を誰でも読める
   （`allow read: if true`）、クライアントからは書き込めない
   （`allow write: if false`）設定にします。Admin SDK からの書き込みはルールを
   バイパスするため影響を受けません。

## 導入手順

### 1. Firebase側の準備
- Firebase Console → プロジェクトの設定 → サービスアカウント →
  「新しい秘密鍵の生成」で JSON キーをダウンロード。
- ダウンロードした JSON の中身を、GitHub リポジトリの
  **Settings → Secrets and variables → Actions** で
  `FIREBASE_SERVICE_ACCOUNT` という名前のシークレットとして登録（値は
  JSONファイルの中身をそのまま貼り付け）。
- `firestore-rules-prices-snippet.txt` の内容を既存の `firestore.rules` に追記し、
  `firebase deploy --only firestore:rules` でデプロイ。

### 2. 依存パッケージ
リポジトリの `package.json` に `firebase-admin` を追加してください:
```
npm install firebase-admin
```

### 3. 既存ワークフロー（`.github/workflows/update-prices.yml`）への追記
`scrape-prices.mjs` が `data/prices.json` を生成した**後**に、次のようなステップを
追加してください（既存のステップ名やファイル名に合わせて調整が必要です）:

```yaml
      - name: Sync prices to Firestore
        run: node scripts/sync-prices-to-firestore.mjs data/prices.json
        env:
          FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
```

このステップが失敗しても（例: シークレット未設定、Firestore側の一時的な障害）、
既存の「data/prices.json をコミットする」ステップとは独立しているため、静的JSON
経由のフォールバックは今まで通り機能します。

## 動作確認
- `node scripts/sync-prices-to-firestore.mjs` をローカルで実行し、Firestore の
  コンソールで `prices/latest` ドキュメントが作成されていることを確認してください。
- アプリ側で `LIVE_PRICE_SYNC.source` を確認すると、実際にどちらのソースから
  取得できたか（`"firestore"` / `"static-json"` / `null`）が分かります
  （ブラウザの開発者ツールのコンソールで `console.log(LIVE_PRICE_SYNC)` などで
  確認できます。UIには現状表示していません）。
