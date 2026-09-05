# Subox AI機能用 Firebase Cloud Functions

`index.html` 側から `api.anthropic.com` を直接呼んでいた箇所（レシート/請求画面のAIスキャン機能）を、
このCloud Functionsを経由するように変更しました。APIキーをクライアントに置かないための対応です。

## 1. 初回セットアップ（まだFirebase CLIを使ったことがない場合）

```bash
npm install -g firebase-tools
firebase login
```

プロジェクトルート（このREADMEがあるディレクトリの一つ上、または任意の場所）で:

```bash
firebase init functions
```

- 既存プロジェクト `subox-studio` を選択
- 言語は JavaScript
- ESLintはお好みで
- 依存関係のインストールは「はい」

その後、生成された `functions/` フォルダの中身を、この `firebase-functions/` フォルダの
`index.js` と `package.json` で置き換えてください。

## 2. Anthropic APIキーをSecretとして登録

Anthropic Consoleで取得したAPIキー（`sk-ant-...`）を、Firebase Functionsのシークレットとして登録します。
**index.htmlや他のコードに直接書かないこと。**

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
```

プロンプトが出たらAPIキーを貼り付けてEnter。

## 3. デプロイ

```bash
firebase deploy --only functions
```

初回デプロイ時、料金プランが Blaze（従量課金）である必要がある旨のメッセージが出ることがあります。
Cloud Functionsの実行には課金の有効化が必要なため、その場合はFirebaseコンソールでBlazeプランに
アップグレードしてください（無料枠の範囲内であれば費用はほぼかかりません）。

## 4. 動作確認

デプロイが終わったら、アプリ側（index.html）は特に追加設定なく、
`firebase.functions(app)` 経由で自動的にこの関数を呼び出します。
アプリの「📷 カメラでスキャン」機能を試して、エラーにならず結果が返ってくることを確認してください。

## リージョンについて

関数は `asia-northeast1`（東京）を指定しています。Firestoreのロケーションと合わせておくと
レイテンシ面で有利です。リージョンを変更する場合は、`index.html` 側で
`firebase.functions(app)` を呼んでいる箇所（`fbFunctions = firebase.functions ? firebase.functions(app) : null;`）
を `firebase.functions(app, "お使いのリージョン")` に変更してください。

## 今後、他のAI機能もサーバー経由にしたい場合

同じパターン（`exports.関数名 = onCall(...)`）で関数を追加し、クライアント側では
`callAiFunction("関数名", { ...渡したいデータ })` を呼ぶだけで使えます
（`callAiFunction` は index.html 内に既に用意してあります）。
