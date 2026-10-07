# Goal013 制作画面の変更と検証

2026-10-07。基準はmain `4df93d73f02b66e34a34861849e79354269bc3bd`。原画像、設計コア、保存形式、AI契約、原寸PDFの生成は維持し、ブラウザで操作する画面を変更した。実装は `feat/013-oss-product-ui`、[参照と採用判断](013-oss-reference.md)を併記する。

## 変えた操作

編集バーを60px、工程を48pxにまとめ、中央の作品と350px（中幅330px）の右操作面へ整理した。候補は同じ領域を置き換える。方向、距離、寸法固定、紙枚数、希望入力、印刷への操作を優先し、材料・全検査・ログを詳細へ移した。希望入力は初期表示され、手動の寸法案とAIを明示的に選ぶ。

比較には共通のbounds・基準位置・再生位相を使い、現在／希望／候補を分ける。未達の距離を希望達成・最大値とは表示しない。採否を詳細より先に置き、原本・希望文を保持する。PDFは内容を選択して一つのダウンロード操作から取得する。組立図と今回の部品を優先し、取得版と閲覧位置を保持する。

表示倍率・全体表示・パンは表示だけに作用する。ドラッグ中のEscapeでパンを取り消した後にpointerupが選択として確定する経路を閉じた。画像エラーには局所の復帰操作まで画面へ入れるスクロールと余白を設けた。フォーカスを強制移動せず、元画像・設計は保持する。

## 証拠と同条件比較

ローカル `artifacts/goal013/before/` と `after/final/` に、サンプルと自作魚PNGの通常操作を各4画面幅で保存。1440×900、1366×768、390×844、320×844で同じ画像・寸法・選択・位相・希望を使う。前後各76状態、入力PNG、採用前／採用後 `.ugoku.json`、通常UIで取得したPDFを関連付ける。SHA・未コミット差分・配信dist・実／模擬種別をmanifestに記録し、撮影時の作業状態を確定コミットと混同しない。

同じ魚の動き画面で、紙の実表示は1440px幅で約490×337pxから752×517px、1366px幅で490×337pxから595×409pxとなった。PCの希望入力とAIボタンは最初の画面内に入る。数値はDOMの表示寸法であり、物理寸法や使いやすさの実験結果ではない。狭幅は縦積みとし、全操作を常時同一画面へ押し込んでいない。`after/before-after-metrics.json` は全比較状態のcanonical hash一致と以下を記録する。

| 画面 | AI操作までのスクロール | 候補採用まで | PDF操作まで |
|---|---:|---:|---:|
| 1440×900 | 165→0px | 0→0px | 0→0px |
| 1366×768 | 297→0px | 0→0px | 0→0px |
| 390×844 | 1,137→384px | 362→37px | 590→290px |
| 320×844 | 1,227→455px | 410→89px | 711→382px |

AIは希望入力を開いた同条件から、対象ボタン下端をviewportへ入れるCSS距離を測った。新PCの右操作面内の追加スクロールも0。希望入力時の表示段落は156→116文字、境界を持つ要素はPC17→14、印刷時も17→14。一方、候補では現在／希望／候補の明示で段落112→125文字・境界12→13となる。すべての文字や枠を減らしたという主張ではなく、比較値と採否を先に読める優先順位へ変更した。

## V1〜V8の確認

| 対象 | 実確認と限界 |
|---|---|
| 新規制作 | 自作PNG→2点選択→寸法→手動候補→比較・採用→同版PDF・取得版ガイド。4幅・2作品を通常UIで操作 |
| AI状態 | ローカルHTTP模擬で候補・代案・待機・中断要求・復帰・通信失敗・受付制限。古い返答／承認・重複・原本保持のassertを維持。追加の実モデル送信0 |
| 比較 | 現在／希望／候補の別表示、同CTM・bounds・位相、1366×768のスライダー、320pxの切替と採否、全13検査のキーボード閲覧 |
| 入力・履歴 | 未確定の空欄・小数・IME・Enter/blur/Escape、1操作1Undo/Redo、工程切替。拡大／パン／fitは設計hash・revision・Undoを変更せず、画面座標から画像座標への選択が一致 |
| 保存 | 実IndexedDB29件。旧形式・移行・容量拒否・StrictMode・競合・復旧・工程／ガイド復元。別タブを上書きしない |
| PDF不変 | 基準版とコア／出力／保存関連25ソースが同一。16文書のdeep equality、保存済み同入力8本・40ページのPDF streamと90dpi RGBAが一致。日時metadataを正規化して8本のbytesも一致。別途100dpiの全10ページも一致 |
| 拡大・狭幅 | 4幅の実画面に横はみ出しなし。Chromiumの実タブズーム200%をsetZoom/getZoomで確認し、制作・PDF・取得版ガイドの7状態を操作。CSS zoom・viewport変更だけの代用とは区別 |
| 操作品質 | 実計算色の文字サンプルは最小5.84:1、主ボタン白文字6.54:1。入力境界／focusの3:1、主要44px操作、メニュー・dialogのフォーカス復帰、reduced motion、合成compositionイベントを確認 |

全コントラストのWCAG適合認証、実OS日本語IME、実スマートフォンのソフトキーボード、初見の参加者、紙への印刷・組立・動作は未確認。小画面のフォーカス／リフロー試験を実端末試験と呼ばない。PDF取得は実物検証ではない。

## 回帰と再現

`npm ci`、`npm run check`（ESLint・型・431単体／統合・build）、`npm run test:e2e`、`npm run test:storage`、`npm run examples`を実行。E2E初回190件中183件成功、接続表示を設定へ移した旧selectorとPDF表記、画像エラーの見切れを修正し、該当28件を再実行して全件成功した。データ保護・設計hash・全ページ・原本保持のassertは削っていない。

WebKitはWSLのOS依存不足でブラウザ起動前に停止、Dockerは未導入。既存の同じspecをChromium／通常サーバーで対照実行し3件成功したが、WebKit／コンテナ成功とは数えない。実WebKit・Dockerはmain同SHAのCIで確認し、結果は公開反映記録に追記する。

```sh
npm ci
npm run check
npm run test:e2e
npm run test:storage
npm run examples
npx playwright test --config playwright.webkit.config.ts
# Dockerのある環境では既存CIと同じbuild/run後に実行
npx playwright test --config playwright.container.config.ts
# build済みUI/APIを複製したAI無効の専用サーバーで実ズーム確認
PRODUCT_ZOOM_OUTPUT_DIR=artifacts/goal013/after/product-zoom npx tsx scripts/check-product-zoom.ts
```

同条件の撮影はAI無効のローカルサーバーを起動し、新しい保存先を指定する。`developer-fish.png` は以前の撮影に使った自作入力そのものを使う。出力先に既存manifestがあれば上書きを拒否する。

```sh
PORT=4194 AI_PROVIDER=none GEMINI_API_KEY= AI_ACCESS_SECRET= LIVE_API_AUTHORIZED= npm start
# 別terminal
CAPTURE_IMAGE_FILE=/absolute/path/to/before/developer-fish.png \
CAPTURE_OUTPUT_DIR=/absolute/path/to/new-capture \
CAPTURE_ORIGIN=http://127.0.0.1:4194 \
node --import tsx scripts/capture-workbench.mjs
```

初回撮影の直後に、画像エラーの局所スクロールだけを追加した。通常の制作画面は変わらず、エラー状態の最新buildでの再確認を別記する。取得済みの画像へ後のコミットで撮影したという実績を付け替えない。

## 統合・公開・提出物

main統合・同SHA CI・同じ既存Cloud Runのアプリ更新と追加AIなしの公開確認を、このローカル確認とは別に記録する。停止フラグ・費用枠・保持予約・監視Job・Scheduler・期限は維持し、SOURCE_SHAとアプリイメージだけを更新する。直前の正常revision／digestを保全する。

新しい提出画像4枚と動画の差し替え章は `artifacts/submission/public/goal013-ui/`。review-v2.1等の旧素材は上書きしない。画像・動画・検証artifactはGit管理外で、GitHubから取得できるとは案内しない。今回の画像の手動候補と、過去動画の実Vertex実績を区別する。動画全面再制作・YouTube公開・Zenn最終提出は行わない。
