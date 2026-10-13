# Zenn提出素材：操作と得られるものを伝える紹介

**投稿用の最新版は `public/goal016-value-first/demo-full-narrated.mp4` です。** 掲載ファイルは同フォルダの短い `README.txt`、タイトル・概要欄は `youtube-description.txt`、画像の見出しは `image-descriptions.txt` を使います。[新版の制作・梱包手順](value-README.md)に実CLIと保存先をまとめています。

新版は163.04秒・18場面・17音声区間です。無音版・音声版の全編デコードと等速再生（4,076フレーム、drop/corrupt 0）、字幕18件の本文・時刻、映像packet一致と独立した目視を確認しました。耳での聴感確認は未実施です。記録は `private/goal016-value-first/` に分け、秘密検査後のZIP生成・展開照合は `package-result.json` を正本とします。新しい公開一式は17ファイルで、詳細manifest・出所記録・私的手順を含めません。旧動画と原稿は以下の履歴として保全します。

## 2分43.04秒本編（履歴）


**前版は `public/goal016-submission/demo-full-narrated.mp4` に保全しています。** 163.04秒（2分43.04秒）・18場面・4,076フレームで、実AIの依頼場面は17.84秒からです。無音版・音声版の全編デコードと1倍再生（drop/corrupt 0）、独立した目視、字幕18件の時刻・本文照合を完了しました。音声版の映像packetは全件一致し、17音声区間を客観検査しました。耳での聴感確認は未実施です。[本編の制作・二段階梱包手順](full-README.md)を参照してください。素材の出所は新しい `README.txt`・`manifest.json`、秘密検査後のZIP生成・展開照合は `private/goal016-submission/package-result.json` を正本とします。

実AIは既存Goal016の1依頼・1送信、20→25mm・第2版への採用記録だけを使います。別撮りは `AI_PROVIDER=none` で、同じ採用設計の印刷・ガイド・保存再開を操作します。追加AI・Cloud操作・アプリ変更は0。画像4枚、PDF、紹介文2欄、構成図、公開手順は旧`goal016-final`から同じバイトで継承します。Zenn未提出は本人確認済みで、投稿・最終提出は素材制作とは別です。

出力先は `artifacts/submission/public/goal016-submission/`、ZIPは `artifacts/submission/ugoku-kami-goal016-submission.zip`。旧Goal016の36.08秒版は履歴ダイジェストとして、以下のGoal014/015原本とともに保持します。秘密を含む審査手順は `artifacts/submission/private/goal016-final/reviewer-instructions.txt` のまま公開しません。

## Goal015の音声付き動画（履歴）


**当時の動画候補は `public/goal015-narrated/demo-narrated.mp4` です。** Goal014の映像・字幕を再圧縮せず、ローカルVOICEVOX Nemo女声1のナレーションを加えます。画像4枚・本文・構成図・PDFは引き続きGoal014一式を使い、無音の元動画とZIPを保全します。[音声と検証の記録](../../docs/goals/015-local-narration.md)を参照してください。

`goal015-narrated/` には音声単体 `narration.wav`、実時刻付き `narration-timed.txt`、設定と出所の `README.txt`／`manifest.json`、`youtube-audio-credit.txt` を同梱します。**YouTube説明欄には「音声：VOICEVOX Nemo（女声1）」を追記**してください。投稿・最終提出は本人作業です。音声付きファイルの客観的な全編再生と、耳での聴感確認は分けます。助手による聴感確認は未実施です。

## ローカル音声の再生成

Python3標準ライブラリ、ffmpeg/ffprobe、Node24、既存Playwrightを使います。アプリサーバー、クラウド、外部音声APIには接続しません。

1. [公式Nemo Engine 0.24.0](https://github.com/VOICEVOX/voicevox_nemo_engine/releases/tag/0.24.0)のLinux CPU/x64版を取得し、[配布hashと規約](../../docs/goals/015-local-narration.md#音声と利用条件)を確認して展開します。今回のローカル配置は `/home/mhirotaka/.local/opt/voicevox-nemo-engine-0.24.0/engine/`。VVPPはZIPで、Pythonで展開した場合は `run` に実行権限を設定します。
2. そのディレクトリで `./run --host 127.0.0.1 --port 50121 --cpu_num_threads 4 --disable_mutable_api --output_log_utf8` を起動します。GPU・公開bind・voice morphingは使いません。
3. 別シェルから以下を実行します。各出力先は未使用の新しいディレクトリを指定します。既存成果物や失敗記録を削除して再実行しません。読みのquery、元音声、正規化音声、測定値も保全します。

```bash
export NARRATION_ASSETS=/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission
export NARRATION_WORK="$NARRATION_ASSETS/private/goal015-narration-reproduction"
export NARRATION_OUT="$NARRATION_ASSETS/public/goal015-narrated-reproduction"
python3 scripts/submission/narrate.py preview --work "$NARRATION_WORK/preview"
python3 scripts/submission/narrate.py render --speaker 10005 \
  --source "$NARRATION_ASSETS/public/goal014-final/demo.mp4" \
  --edl "$NARRATION_ASSETS/private/goal014-final/video/edit-decisions.json" \
  --work "$NARRATION_WORK/render" --out "$NARRATION_OUT"
node scripts/submission/narration-review.mjs \
  --movie "$NARRATION_OUT/demo-narrated.mp4" \
  --source "$NARRATION_ASSETS/public/goal014-final/demo.mp4" \
  --manifest "$NARRATION_OUT/manifest.json" --out "$NARRATION_WORK/review"
```

完了後は自分で起動したNemo engineだけを停止します。レビュー用ブラウザとloopbackサーバーはスクリプトが終了処理します。原稿の変更は `narration-plan.json` で管理し、変えた音声・映像に対して再検証してください。`demo-narrated.mp4` と `narration.wav` の音声、話者クレジット、規約リンクは公開・配布先にも引き継ぎます。

以下は保全するGoal014無音原本とその他提出物の制作手順です。

**Goal014当時の提出候補は `goal014-final` です。** 動画は160.60秒（2分40.60秒）。全編再生・目視・ZIP展開照合を完了しました。使用するファイルは、ローカルの `artifacts/submission/public/goal014-final/README.txt` と `manifest.json` を基準にしてください。旧review-v2.1と以前のGoal011素材は保全し、混在させません。

紹介文・画像順・動画章のコピーは [`final-copy.json`](final-copy.json)、出所と版の区別は [Goal014記録](../../docs/goals/014-current-ui-submission.md)にまとめます。画像・MP4・PDF・本文・構成図・ZIPはGit管理外で、GitHubには同梱しません。秘密・生ログ・artifacts全体をGitへ追加しません。

| Zennで使うもの | `public/goal014-final/` 内のファイル |
|---|---|
| 画像1：動かすところを選ぶ | `images/01-select-your-art.png` |
| 画像2：方向と距離を決める | `images/02-set-the-motion.png` |
| 画像3：手動20→25mmの案を比べる | `images/03-compare-manual-proposal.png` |
| 画像4：採用した25mm・第7版の印刷画面 | `images/04-print-the-adopted-version.png` |
| 動画 | `demo.mp4`。最終尺はmanifestで確認し、本人によるYouTube投稿後の実URLを動画欄へ |
| 課題と解決 | `problem-solution.txt`：282文字 |
| アーキテクチャ説明 | `architecture.txt`：328文字 |
| 構成図 | `architecture.png`、`architecture.svg`（既存図を同じバイトで使用） |
| 素材一覧・出所・版・検査 | `README.txt`、`manifest.json` |

画像は `public/goal013-ui/` の既存4枚を同じ順・同じバイトでコピーします。動画Aの新UI手動25→30mmと画像の手動20→25mmは別の記録です。過去の実Vertex録画は旧UIと日付を明示した短い抜粋に限定し、依頼は「30mmにする」という絶対量指定のまま説明します。その後、「採用した設計を新UIで開く」と示して、別セッションBで30mm・第3版のPDF・ガイド・保存再開へ進みます。

紹介文2欄はreview-v2.1の製品説明を保ち、どちらもコードポイント数・UTF-16で800以下です。新しいメディアの再生・目視・hash・ZIP検査は、最終ファイルに対して記録します。旧動画の検査成功は引き継ぎません。確定尺と検査結果は最終manifestに記録します。一式ZIPの出力先は `artifacts/submission/ugoku-kami-goal014-final.zip` です。

非公開の審査手順は新UIへ更新し、アクセスコードを旧原本からそのまま引き継ぎます。コードをこのREADME・公開コピー・画像・動画・ZIPへ含めません。公開アプリ・Cloud・AI推論は今回の素材制作で変更／実行しません。YouTube投稿、Zenn最終提出、実物確認の完了を素材完成から推定しません。

## 新UI版の保存先と再生成

現在のローカル保存先は `/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission/` です。

| 用途 | `artifacts/submission/` からの相対パス |
|---|---|
| 当時の公開素材 | `public/goal014-final/` |
| 一式ZIP | `ugoku-kami-goal014-final.zip` |
| 非公開の審査手順 | `private/goal014-final/reviewer-instructions.txt`（0600、公開一式へ含めない） |
| 新収録・時刻補正・編集・レビュー・保全証拠 | `private/goal014-final/` |
| 旧版 | `public/goal011/review-v2.1/` と旧ZIPを含む各原本 |

Node24、`npm ci`、ビルド済みの現行UI/API、Playwright Chromium、ffmpeg/ffprobe、Python3を使います。元の採用プロジェクト、過去の録画、Goal013の4画像・manifest、旧構成図が存在する環境が必要です。GitHubだけから元の私的録画を復元できる手順ではありません。

収録は現在のスクリプトが受け付ける基準mainと同じ製品ソースで行います。`final-capture.mjs` はポート4874へ自分のローカルサーバーを起動し、`AI_PROVIDER=none`・`AI_PUBLIC_RELEASE=false`を確認します。既存サーバーを流用せず、外部URLとAI依頼を遮断します。これ以降もCloud API・公開サービス・モデルへ接続しません。レビュー時のHTTPは動画だけを配る新しいloopbackサーバーです。

### 1. 新UIを手動収録する

リポジトリのルートから実行します。`--rehearsal` は映像を収録しない短縮確認用なので、提出用の本収録では付けません。採用正本のバイトhash、30mm・第3版・設計hashはスクリプトが検査します。

```bash
npm run build
export GOAL014_ASSETS=/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission
export GOAL014_WORK="$GOAL014_ASSETS/private/goal014-final"
export GOAL014_ADOPTED="$GOAL014_ASSETS/private/goal010/browser-sequence-2026-10-05T09-11-37.048Z/recovery/adopted.ugoku.json"
node scripts/submission/final-capture.mjs --out "$GOAL014_WORK/capture" --adopted "$GOAL014_ADOPTED"
```

出力された `runDirectory` の `capture.json` が成功・本収録であることを確認し、その絶対パスを `GOAL014_CAPTURE` に設定します。失敗・リハーサルのフォルダを自動的に選ばないでください。

### 2. 時刻を照合し、編集・再生検査する

以下の `<successful-run-directory>` は、直前の本収録で表示されたフォルダ名へ置き換えます。`--capture-dir` と `--plan` は必須です。これらのGoal014スクリプトに `--edition` 引数はありません。

```bash
export GOAL014_CAPTURE="$GOAL014_WORK/capture/<successful-run-directory>"
node scripts/submission/final-timing.mjs --capture-dir "$GOAL014_CAPTURE"
node scripts/submission/final-plan.mjs --assets-root "$GOAL014_ASSETS" --capture-dir "$GOAL014_CAPTURE"
node scripts/submission/final-video.mjs --assets-root "$GOAL014_ASSETS" --plan "$GOAL014_WORK/video-plan.json"
node scripts/submission/final-review.mjs --assets-root "$GOAL014_ASSETS"
```

`verified-pts.json` は実WebMのフレーム時刻と独立マーカーから作ります。前後の実フレームで切出し境界を確認します。過去の実Vertex映像は、hashが固定された録画の4.88〜15.00秒だけを使い、旧UIと日付を表示します。新UIへ過去のモデル応答を合成しません。冒頭はAの同じ手動作品、後半Bは旧AIで採用した別作品・30mm第3版であることを、編集計画と実画面の両方で確認します。

`final-review.mjs` はMP4とEDLのhash、全フレームのデコード、等速での全編再生、各場面の中点と全カット前後を記録します。技術的に再生できることと、字幕・秘密設定の除外・版の対応の目視は別です。新動画の尺や検査成功を旧版から転記しません。

### 3. 目視結果とPDFの対応を記録してパッケージ化する

パッケージ処理の前に、次の実証拠を `private/goal014-final/` へそろえます。空の承認ファイルや未実施の成功値では代用しません。

- `preservation.json`：旧素材90件の相対パス・サイズ・hashを記録した保全原本。処理の前後で同じバイトかを検査します。
- `acceptance.json`：完成MP4のhash、目視した範囲を表す `visual`、4画像のfile/hash、実際に確認を終えた `accepted:true`。再生でdropがある場合は、その確認を別に明示します。
- `pdf-bindings.json`：`pdfs`配列へ、`historical-adopted`の `historical-adopted-30mm-r3.pdf` と、同梱する場合だけ`new-ui-manual`の `manual-proposal-30mm.pdf` を記録します。各項目のsource・sha256・designId・revision・designHashは、今回の `capture.json` にある `kit-B.pdf`／`manual-A.pdf` の実値を使い、そのPDFを同じバイトで公開出力先へ配置します。以前の同版PDFを今回のダウンロードへ付け替えません。

PDFはA4・版・設計hash・実物未確認のmetadataと照合され、EDLの撮影記録hashと、実際に動画へ使ったB/Aの録画まで結ばれます。旧コードは非公開ファイルからメモリ内だけで読み、公開素材とZIP展開結果へ混入していないか検査します。コードは表示・転記しません。

```bash
node scripts/submission/final-package.mjs --assets-root "$GOAL014_ASSETS"
```

この処理が画像4枚と既存構成図を同じバイトでコピーし、本文・README・manifest・ZIPを作ります。公開フォルダとZIPは許可されたファイルだけに限定し、ZIP全件を展開して実ファイルとのバイト一致を確認します。main統合後に `integration-status.json` を追加する場合は、実際の最終main SHA・push・同SHAのCheckとWebKit成功だけを記録します。撮影時の製品SHAと制作コードの統合SHAは分けます。

### 再実行と原本保全

収録は毎回新しい時刻名フォルダです。時刻補正、計画、レンダー、レビューは既存の専用出力ディレクトリや排他的JSONがあると拒否します。途中失敗時もその記録を残し、既存のMP4・EDL・検査・保全記録を削除して通さないでください。再制作する場合は既存成果物を別の保全先へ退避し、対応するhashと参照を確認してから、新しい出力の組としてやり直します。

パッケージだけの再実行は、動画・画像・PDFなどの入力バイトが変わらない場合にREADME／manifestを更新できます。既存ZIPは、その回の `package-*` 作業フォルダへ `previous-public-package.zip` として保存してから置き換えます。動画や画像を変更した場合は、その新hashに対する再生・目視確認を先に完了してください。旧review-v2.1等の90原本は常に不変確認の対象です。

以下は旧版を保全・再現するための履歴です。新版の作成や提出ファイルの選択には使わないでください。

## 旧review-v2.1の変更と再生成

最初の10秒は、同じ実AI作品の基準25mm画面、25→30mmの候補比較、採用した30mm第3版のPDFとガイドを静止抜粋で紹介します。連続操作とは扱わず、その後の手動デモも別セッションとして表示します。重複する選択確認を2秒短縮し、総尺177.12秒を維持。33秒以降の映像、4画像、本文2欄、構成図、既存PDFは旧review-v2と同一です。

### 旧review-v2.1を保存済み素材から再生成

Node24、`npm ci`、Playwright Chromium、ffmpeg/ffprobe、Python3を使います。元の私的録画・確定PTS・出所画像が存在する環境で実行してください。クラウドや製品サーバーへは接続しません。

```bash
export SUBMISSION_ASSETS=/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission
export SUBMISSION_CAPTURE="$SUBMISSION_ASSETS/private/material-redesign-20261006/capture/2026-10-06T11-08-57.619Z"
node scripts/submission/redesign-video.mjs --assets-root "$SUBMISSION_ASSETS" --capture-dir "$SUBMISSION_CAPTURE" --edition review-v2.1
node scripts/submission/redesign-review.mjs --assets-root "$SUBMISSION_ASSETS" --edition review-v2.1
node scripts/submission/redesign-package.mjs --assets-root "$SUBMISSION_ASSETS" --edition review-v2.1
```

制作スクリプトは旧review-v2のハッシュを照合し、4画像は同じバイトでコピー、変更していない映像区間も同じエンコード済みファイルを再利用します。保全記録のある環境では、edition引数を省略して旧版を上書きする処理も拒否します。新しい画像生成・モデル呼出し・再収録は不要です。元版を再制作するコードは`663f10b`の履歴に残ります。

検査は全4428フレームのデコード、1xでの全編再生、22場面の中点と21カット前後の実フレームを対象にします。技術的に再生できたことと目視確認は分けます。確認後、対象の動画・画像hashと実見範囲を `private/material-finalize-20261006/acceptance.json` に記録してからパッケージを作ります。再レビュー時は過去の証拠を別名で保持し、既存のreviewフォルダを上書きしません。

旧版と新しい候補の私的証拠はそれぞれ `private/material-redesign-20261006/` と `private/material-finalize-20261006/` に分かれます。実物の印刷・組立・動作確認は未実施です。

以前のローカルGemma収録手順は [過去の収録資料](legacy-local-recording.md) に保全しています。この節は旧review-v2.1だけの再生成手順です。
