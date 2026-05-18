# BalletSchedule

バレエスタジオの月次スケジュール表示 Web アプリ。
LINE/PDF に分散しているリハーサル予定を、 月ごとのカレンダーで見渡せる読み取り補助具。

## 構成

```
BalletSchedule/
├── index.html               ← 単一 HTML、 全ロジック (閲覧 + 取り込み UI)
├── meta.json                ← studios / types / 全月共通の補足
├── data/
│   ├── 2026-04.json         ← 種データ (静的 fallback)
│   ├── 2026-05.json
│   └── (Worker が KV にあれば KV 優先、 なければここから)
├── proxy/                   ← Cloudflare Worker (API + KV ストレージ)
│   ├── worker.js
│   ├── wrangler.toml
│   └── README.md            ← デプロイ手順
└── README.md
```

## 取り込み機能 (v4)

予定を **アップロード** できる UI が実装されています:
- 🟢 **JSON 貼り付け**: Claude/ChatGPT が出した events 配列をコピペ
- 🟢 **テキスト RegEx**: LINE 文面/PDF テキストをコピペ → 自動認識
- 🟢 **PDF アップロード**: PDF ファイル → ブラウザ内 PDF.js で抽出 → RegEx

### 配布フロー (2 通り)

**A. クラウド配布** (Cloudflare 設定後): アップロードキー付き URL を持ってる人 (大作さん + 奥さん) が画面から取り込み → 全員のブラウザに即時反映。 `proxy/README.md` 参照。

**B. ローカル運用** (Cloudflare なし): 取り込み結果を JSON ダウンロード → 大作さんが GitHub に commit/push。 現状の方式。

### アップロードキーの共有

`#key=...` 付き URL を開くと、 アップロード機能が有効化される (localStorage に保存):
```
https://dai-hydrangea.github.io/ballet-schedule/#key=YOUR_UPLOAD_KEY
```
`key` を一度開けば、 次回以降は通常 URL でも有効。 閲覧専用の人には `#key` なしを共有。

## ローカル試験

`file://` 直接開きだと CORS で fetch が落ちるので、 必ず http サーバ経由で開く。

```bash
cd BalletSchedule
python3 -m http.server 8765
open http://localhost:8765/
```

## 月ナビゲーション

- ヘッダの ◀ ▶ ボタン
- 矢印キー (←/→)
- タッチデバイスでは カレンダー領域を **左右スワイプ**

対応範囲: `2026-04` 〜 `2030-12`。 範囲端では該当ボタン無効化。

## 新しい月の予定を追加

1. `data/YYYY-MM.json` を作る (既存月を雛形にコピー)
2. `events` 配列に予定を追加
3. ブラウザリロード ── 該当月にナビすれば反映

### イベント 1 件の形

```jsonc
{
  "date": "2026-06-07",        // ISO 日付
  "start": "13:30",            // HH:MM (24h)
  "end":   "15:30",
  "studio": "kawagoe",         // meta.json の studios キー
  "type":   "rehearsal",       // lesson | rehearsal | choreography
  "label":  "海賊",
  "tags":   ["海賊"],          // 演目タグ (絞り込みに使う)
  "target": "海賊出演者",       // 対象、 任意
  "note":   "全員集合 14:30"    // 任意
}
```

### 終日扱いにする (例: 振付のみの日)

`start: "00:00"`、 `end: "23:59"` で、 時間軸グリッドの外に "終日" ブロックとして表示される。

### スタジオを追加する

`meta.json` の `studios` に新しいキーを追加。 `color` (帯) と `bg` (背景薄色) のペアで定義。
左カラム (川越・合同・みよしの) と右カラム (所沢) の振り分けは `index.html` 内の `LEFT_STUDIOS` / `RIGHT_STUDIOS` 定数で調整。

## v2 のスコープ (今ここ)

- [x] 大きな月カレンダー (1 画面で月全体)
- [x] 日タップ → ボトムシートに 1日分の Outlook 風時間軸グリッド
- [x] 時間軸 2 カラム (左: 川越/合同/みよしの、 右: 所沢)
- [x] スタジオ別色分け + 種別アイコン (L/R/C)
- [x] 絞り込み (スタジオ / 種別 / 演目タグ) + 全選択/全消し
- [x] 月切替 (◀ ▶ / 矢印キー / スワイプ)、 2026-04 〜 2030-12
- [x] メモ一覧 (note 付き event をシート下部にまとめ表示)
- [x] mobile-first レイアウト
- [x] GitHub Pages 配信 (noindex 設定済)

## v3 以降の TODO

### 取り込み自動化 (コスト最小路線)

- [ ] LINE 画像 / PDF / LINE 文面コピー → events.json
- [ ] ブラウザ内で完結 (PDF.js でテキスト抽出、 Tesseract.js OCR 等)
- [ ] API は最後の手段

### 表示・編集

- [ ] 各スケジュールタップで実編集 (キー保持者のみ)
- [ ] 印刷用レイアウト
- [ ] ICS エクスポート

## 設計思想

- 月別ファイル = 月ごとに独立管理、 過去履歴も残せる
- 共通情報 (studios/types) は `meta.json` に分離
- 通常レッスンは載せない方針 (公式 Web を参照)
- 個人情報を持たない (= クラス/スタジオ単位)
- 既存ツール (LINE/PDF) を壊さない、 表示層だけ自作

## 既知の制約

- ブラウザ依存 (file:// 直接は CORS、 http サーバ経由必須)
- 月またぎイベント未対応 (1 月単位)
- 編集 UI は v3 で予定 (現状は JSON 直編集)
