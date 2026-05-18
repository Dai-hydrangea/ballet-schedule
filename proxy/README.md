# BalletSchedule Cloudflare Worker (API + KV)

ブラウザからアップロードされた月別 events を Cloudflare KV に保存・配信する Worker。

## 構成

```
ブラウザ (家族) ─┐
                 │  POST /api/upload?month=YYYY-MM  (X-Upload-Key 認証)
                 │  GET  /api/data/YYYY-MM
                 ▼
        Cloudflare Worker (ballet-schedule-api)
                 │
                 ▼
        Cloudflare KV (Namespace: BALLET_KV)
        Keys: 2026-04, 2026-05, ...
```

## デプロイ手順 (初回のみ)

### 0. 前提

- Cloudflare アカウント (無料)
- Node.js (`node --version` で確認、 多分既に入ってる)
- `wrangler` は **`npx` 経由で都度実行**するので global install 不要

### 1. ログイン (初回のみ)

```bash
cd ~/Developer/BalletSchedule/proxy
npx wrangler login
```

ブラウザが開いて Cloudflare の OAuth 画面 → 「Allow」。

### 2. KV namespace を作成

```bash
npx wrangler kv namespace create BALLET_KV
```

(古い wrangler v2 系なら `kv:namespace` のコロン形式、 v3+ なら `kv namespace` のスペース形式)

出力例:
```
🌀 Creating namespace with title "ballet-schedule-api-BALLET_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "BALLET_KV"
id = "abc123def456..."
```

`wrangler.toml` の `id = "PASTE_KV_NAMESPACE_ID_HERE"` を、 出力された ID に書き換える。

### 3. アップロードキー (secret) を設定

```bash
npx wrangler secret put UPLOAD_KEY
```

プロンプトで好きな文字列 (16〜32 文字推奨、 例: `balllet-2026-spring-xyz`) を入力。
**このキーは家族と共有する URL ハッシュ に使う**ので、 推測されにくいものを。

### 4. デプロイ

```bash
npx wrangler deploy
```

出力されるエンドポイント URL を控える。 例:
```
https://ballet-schedule-api.<your-cf-account>.workers.dev
```

### 4. アプリ側に URL を設定

`../index.html` の冒頭で `const API_BASE_URL = '';` を、 上記の Worker URL に書き換え。

```js
const API_BASE_URL = 'https://ballet-schedule-api.your-account.workers.dev';
```

git commit → push すれば反映。

### 5. 家族にアップロード用 URL を共有

```
https://dai-hydrangea.github.io/ballet-schedule/#key=<UPLOAD_KEY>
```

`#key=...` 付きの URL を開いた人だけ、 アプリの「取り込み」 ボタンが有効になる。
閲覧専用の人には `#key` なしの URL を共有 (= 取り込みは見えないが閲覧可)。

`#key` を一度開けば localStorage に保存されるので、 次回以降は通常 URL でも取り込み可能。

## 動作確認

```bash
# 閲覧 (KV が空なら 404、 アプリ側で GitHub 静的ファイルに fallback)
curl https://ballet-schedule-api.your-account.workers.dev/api/data/2026-05

# アップロード (要 UPLOAD_KEY)
curl -X POST \
  -H "X-Upload-Key: <UPLOAD_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"events":[]}' \
  'https://ballet-schedule-api.your-account.workers.dev/api/upload?month=2026-06'
```

## バリデーション

Worker は受け取った events を以下でチェック:
- `date`: ISO 日付 (YYYY-MM-DD)
- `start` / `end`: HH:MM
- `studio`: kawagoe / tokorozawa / miyoshino / joint のいずれか
- `type`: lesson / rehearsal / choreography のいずれか
- `label`: 必須、 200 文字以下
- `note`: 任意、 500 文字以下
- 月あたり最大 200 イベント

エラー時は 400 で `{ error, detail }` を返す。

## コスト

完全に **¥0** (無料枠内):
- Worker: 100,000 req/日 (バレエ用途では使い切れない)
- KV read: 100,000 op/日
- KV write: 1,000 op/日 (アップロードは月数回〜数十回想定)
- ストレージ: 1GB 無料 (1 月分 events は 数十KB)

## トラブル時

### Worker のログを見たい
```bash
npx wrangler tail
```

### KV の中身を確認
```bash
# v3+
npx wrangler kv key list --binding BALLET_KV
npx wrangler kv key get --binding BALLET_KV "2026-05"

# v2 (コロン形式)
npx wrangler kv:key list --binding BALLET_KV
npx wrangler kv:key get --binding BALLET_KV "2026-05"
```

### KV から削除
```bash
npx wrangler kv key delete --binding BALLET_KV "2026-05"
```

### Node が入ってない場合

```bash
# Homebrew で
brew install node

# またはバージョン管理したいなら nvm 経由
brew install nvm
nvm install --lts
```
