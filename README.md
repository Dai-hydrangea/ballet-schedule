# BalletSchedule

バレエスタジオの月次スケジュール表示 Web アプリ。
LINE/PDF/Web に分散しているレッスン・リハーサル予定を、 一画面で見渡せる読み取り補助具。

## 構成

```
BalletSchedule/
├── index.html      ← 単一 HTML、 fetch で events.json を読み込み描画
├── events.json     ← データ本体 (SSOT)。 ここを編集すれば即反映
└── README.md
```

## ローカル試験

`file://` 直接開きだと CORS で fetch が落ちるので、 必ず http サーバ経由で開く。

```bash
cd BalletSchedule
python3 -m http.server 8765
open http://localhost:8765/
```

## events.json の編集

### データ構造の 3 層

1. **`weekly_templates`** ── 曜日固定の通常レッスン (週次パターン)
2. **`events`** ── 特別予定 (リハーサル / イベント)
3. **`exceptions`** ── 通常レッスンお休み日 (リハに置換 / 振付のみ等)

`index.html` はこの 3 つを merge して表示する。

- 通常レッスンを増減 → `weekly_templates`
- リハーサル予定が来たら → `events` に追加
- レッスンお休み日 → `exceptions` に `skip_templates: true` で追加

### 「第n週」 のクラス (例: オーロラ・ピラティス・Va)

`weekly_templates[].items[].note` に「第1・3週」 等を入れておくと、 該当週でのみ表示される。

### スタジオを増やす

`studios` キーに新エントリを追加。 `color` (border) と `bg` (背景薄色) のペアで定義。

## v1 のスコープ (今ここ)

- [x] 月全体ミニカレンダー (sticky、 タップでジャンプ)
- [x] 縦に日次セクション (アンカースクロール、 イベントタップで詳細展開)
- [x] スタジオ別色分け + 種別アイコン (L=レッスン / R=リハ / C=振付)
- [x] フィルタ (スタジオ / 種別 / 演目タグ) + 全選択/全消し
- [x] 例外日表示 (お休み・振付のみ)
- [x] 「今日」 ハイライト + 起動時に今日へオートスクロール
- [x] mobile-first レイアウト
- [x] GitHub Pages 配信 (noindex 設定済)

## v2 以降の TODO

### 取り込み自動化

- [ ] **複数ソース取り込み**: LINE 画像 / PDF / LINE 文面コピー → events.json
- [ ] **API コスト最小化**: できるだけローカル/ブラウザ内で完結 (PDF.js でテキスト抽出、 Tesseract.js で OCR 等)、 API は最後の手段
- [ ] 通常レッスンの自動同期 (Web 公開済スケジュールページから)

### 表示・編集

- [ ] 月切替 (前月/次月)
- [ ] 各スケジュールをタップで実編集 (キー保持者のみ)
- [ ] 印刷用レイアウト (A4 縦・月 1 枚)
- [ ] ICS エクスポート (Google Calendar / iOS カレンダーに取り込み可)

## 設計思想

- 抽象空間 (events.json) と表示空間 (index.html) を分離 → データ更新だけで運用継続
- 個人情報を持たない (= クラス/スタジオ単位でフィルタ可能、 v1 では個人プロフィールは実装しない)
- 既存ツール (LINE/Google) は壊さない、 表示層だけ自作
- アプリは入口、 完結させない (= 観られる UI に集中投資)

## 既知の制約

- events.json の月またぎ未対応 (1 月分ずつ管理)
- リハの「対象生徒個別」 までは表示できない (note 欄に書く運用)
- ブラウザ依存 (file:// 直接は CORS で動かない、 http サーバ経由必須)
