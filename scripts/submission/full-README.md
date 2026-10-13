# Goal016の提出用本編

**YouTubeへ投稿するファイルは `public/goal016-submission/demo-full-narrated.mp4`。** 本編は163.04秒（2分43.04秒）、1920×1080・25fps、全4,076フレーム・18場面です。実AIの依頼場面は17.84秒から始まります。無音版・音声版とも全編デコードと1倍再生が成功し、drop/corruptは0。独立した目視確認と字幕18件の時刻・本文照合を完了しました。音声版は全4,076映像packetが無音版と一致し、17音声区間の客観検査も成功しました。耳での聴感確認は未実施です。

同フォルダの `README.txt`・`manifest.json` に素材の一覧と出所を記録します。秘密検査後のZIP生成・16件の展開照合結果は `private/goal016-submission/package-result.json` を正本とし、動画の検査完了から梱包完了を推定しません。

既存Goal016の実AI 1依頼・モデル送信1回で、20mmから25mmの候補を第2版へ採用した録画を使用します。収録アプリのsourceは `6c1b858bbe73542d179334b84ef4aefe57de65aa`。新しい収録は、同じ採用設計を別セッションで開くローカルの印刷・ガイド・保存再開です。`AI_PROVIDER=none`、追加AI送信・Cloud操作・アプリ変更は0。実AIの応答を新しく作ったり、ローカル画面へ合成したりしません。実録、別セッション、説明用の静止画を区別します。

Zenn未提出は本人確認済みです。素材完成をYouTube投稿・最終提出・実物の印刷や組立の成功とは扱いません。助手による耳での聴感確認も、音声信号・同期・全編再生の客観検査とは別の未確認事項です。

## 保存先と16ファイル

`FULL_ASSETS` は既存の `artifacts/submission` の絶対パスです。標準の保存先は `/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission`。公開一式は `public/goal016-submission/`、制作証拠は `private/goal016-submission/`、ZIPは `ugoku-kami-goal016-submission.zip` です。非公開審査手順は `private/goal016-final/reviewer-instructions.txt` を維持し、ZIPへ含めません。

| ファイル | 出所・用途 |
|---|---|
| `demo-full-narrated.mp4` | 新しい本編。YouTube投稿用、ローカルNemo音声付き |
| `demo-full.mp4` | 新しい本編の無音原本 |
| `captions.srt` | 新しい本編と同時に生成する字幕 |
| `narration-timed.txt` / `youtube-audio-credit.txt` | 実時刻付き音声原稿とクレジット |
| `README.txt` / `manifest.json` | ファイル選択、出所、版、hashと検証範囲 |
| `images/01-select-your-art.png` | 旧Goal016実画面の同一バイト |
| `images/02-describe-the-motion.png` | 同上 |
| `images/03-compare-the-ai-proposal.png` | 同上。実AIの現在20mm・候補25mm比較 |
| `images/04-print-the-adopted-version.png` | 同上。採用した25mm・第2版 |
| `adopted-same-version.pdf` | 同じ採用版の旧Goal016 PDFを同一バイトで継承 |
| `architecture.png` | 旧Goal016の構成説明図を同一バイトで継承。実画面ではない |
| `problem-solution.txt` / `architecture-description.txt` | 旧Goal016の紹介文2欄を同一バイトで継承。各800文字以下 |
| `review-instructions-public-note.txt` | 旧Goal016のコードを含まない公開手順を同一バイトで継承 |

旧Goal016の36.08秒動画は履歴ダイジェストです。旧Goal016の公開・非公開素材とZIP、計164ファイル・61,440,209バイトを `private/goal016-submission/preservation.json` に固定しています。梱包の前後で全件のサイズ・SHA-256を照合します。旧Goal014/015はこの164件には含まず、別途そのまま保全します。秘密を含む旧ファイルも保全hashのためにバイトとして読みますが、梱包処理はコードを抽出・表示・公開コピーしません。

## 再現の順序

Node24、既存依存、Playwright Chromium、Python3、ffmpeg/ffprobe、pdftoppm、既存のローカルVOICEVOX Nemo Engine 0.24.0を使います。ローカル収録用アプリは実AI収録と同じ `6c1b858bbe73542d179334b84ef4aefe57de65aa` をビルドした専用worktreeです。GitHubのソースだけから元の私的録画や採用正本を再生成できる手順ではありません。

出力は新規作成に限定します。既存の動画、証拠、stage、ZIPがあれば保全して止めます。削除・上書きしての再実行はしません。失敗時の部分出力も保持し、必要な再制作は別の作業先へ全入力を明示して行います。以下は順序と実CLIを示し、未取得の入力やレビューを飛ばすコマンドではありません。

```bash
export FULL_ASSETS=/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission
export FULL_WORK="$FULL_ASSETS/private/goal016-submission"
export FULL_PUBLIC="$FULL_ASSETS/public/goal016-submission"
```

1. 保全manifestを先に作り、旧実AIcaptureと採用正本を固定します。追加AI収録は行いません。
2. 同じ採用設計をローカル手動収録します。`FULL_APP` は担当が用意した同SHA・ビルド済み専用worktreeの絶対パスです。本収録では `--rehearsal` を付けません。

```bash
node scripts/submission/full-capture.mjs \
  --app-root "$FULL_APP" \
  --out "$FULL_WORK/local-capture" \
  --adopted "$FULL_ASSETS/private/goal016-final/capture/2026-10-13T17-11-18.589Z/adopted.ugoku.json"
```

収録scriptは独自のloopbackサーバーを起動し、`AI_PROVIDER=none`と同SHAの配信ファイルを確認します。外部通信とAI送信を遮断します。得られた `capture.json` と実PTSの安全区間を参照して `private/goal016-submission/video-plan.json` を作ります。旧実AIと新ローカルのcapture/hashを分け、同じ設計・版・PDFへの結び付きを保ちます。

3. `full-script.json` の17章の新原稿を、既存loopback Nemoで先に実測します。速度1の音声を短く切ったり伸縮したりせず、発話が収まる章尺を検討します。測定結果と実PTSから動画計画を確定して本編を生成し、同じ完成ファイルに対して全編デコード・等速再生・場面と境界の抽出を行います。`FULL_PREPARED` は凍結した最終原稿に対応する計測ディレクトリです。以下は未使用の `prepared-final` に生成する例で、既存の途中版や確定版を上書きしません。

```bash
export FULL_PREPARED="$FULL_WORK/narration/prepared-final"
python3 scripts/submission/full-prepare-narration.py \
  --script scripts/submission/full-script.json \
  --out "$FULL_PREPARED"
node scripts/submission/full-video.mjs \
  --assets-root "$FULL_ASSETS" \
  --plan "$FULL_WORK/video-plan.json"
node scripts/submission/full-review.mjs --assets-root "$FULL_ASSETS"
```

`full-media.mjs` は各映像の許可区間と出所、採用正本、PDFから直接描画したページを照合します。設定画面を含む私的raw全体を公開可能と扱いません。レビューは全フレームをデコードしますが、目視の対象は記録した抽出画面と範囲です。全フレームを原寸で個別目視したとは称しません。

4. `full-narration-plan.py` で完成EDL、凍結原稿、採用した最終計測manifestを結び付け、音声計画 `narration/plan.json` を新規作成します。章とsceneの順序・連続性、全sceneが一章に属すること、本文と読みの一致を検査します。章の前後へ各0.15秒の余白を設け、実測した発話が収まらなければ停止します。既存Nemoは `127.0.0.1:50121` だけを使用します。`full-narrate.py` の任意の `--prepared` には、そのmanifestを含む**同じディレクトリ**を指定します。本文・読み・話者設定・音声hashを照合して同じ音声を使い、省略時はローカルで新規生成します。発話は切り詰めず、映像はstream copyで維持します。

```bash
python3 scripts/submission/full-narration-plan.py \
  --edl "$FULL_WORK/video/edit-decisions.json" \
  --script scripts/submission/full-script.json \
  --prepared "$FULL_PREPARED/manifest.json" \
  --out "$FULL_WORK/narration/plan.json"
python3 scripts/submission/full-narrate.py \
  --source "$FULL_PUBLIC/demo-full.mp4" \
  --edl "$FULL_WORK/video/edit-decisions.json" \
  --plan "$FULL_WORK/narration/plan.json" \
  --prepared "$FULL_PREPARED" \
  --work "$FULL_WORK/narration/work" \
  --out "$FULL_WORK/narration/output"
node scripts/submission/full-narration-review.mjs \
  --movie "$FULL_WORK/narration/output/demo-full-narrated.mp4" \
  --source "$FULL_PUBLIC/demo-full.mp4" \
  --manifest "$FULL_WORK/narration/output/manifest.json" \
  --out "$FULL_WORK/narration/review"
```

音声には「音声：VOICEVOX Nemo（女声1）」を記し、YouTube説明欄にも `youtube-audio-credit.txt` を転記します。[Nemo利用規約](https://voicevox.hiroshiba.jp/nemo/term/)も引き継ぎます。外部音声API・本人の声の複製は使用しません。

5. 担当が新しい完成映像の目視を終え、`acceptance.json` を固定します。必須項目は `accepted:true`、無音本編に一致する `videoSha256`、確認範囲を記録する `visual` です。再生でdropがあった場合は、その影響を確認して `visual.droppedFramesReviewed` / `visual.narrationDroppedFramesReviewed` を明示します。技術レビューの `pending-human-inspection` は独立したこの記録で補い、成功したことに書き換えません。
6. stageで旧静的9ファイルを同じバイトでコピーし、新しい動画・音声・説明と合わせて16ファイルを固定します。

```bash
node scripts/submission/full-package.mjs --assets-root "$FULL_ASSETS" --mode stage
```

stageは150〜180秒、実AIとローカルcaptureの区別、採用版PDF、旧ファイルの同一性、完成MP4と各レビューのhash、音声付き動画の映像packet一致を照合します。最終main CI記録があれば `private/goal016-submission/integration-status.json` に置きます。収録時の配信SHAへ後から付け替えません。

7. 権限を持つ担当が固定された同じ16ファイルへ秘密値のバイト検査と目視を実施し、次の形で `secret-scan-attestation.json` を新規保存します。コードの値は検査記録へ含めません。

```json
{
  "format": "ugoku-goal016-submission-secret-scan-v1",
  "result": "passed",
  "candidateSha256": "package-candidate.jsonの実SHA-256",
  "knownCredentialByteScan": true,
  "secretValuesPrinted": false,
  "visualNoCredential": true,
  "files": ["package-candidate.jsonのfilesと同じ順・同じfile/bytes/sha256レコード"]
}
```

8. sealは検査済みバイト列だけをZIP化し、16件全てを展開して照合します。

```bash
node scripts/submission/full-package.mjs --assets-root "$FULL_ASSETS" --mode seal
```

`package-result.json` にZIP hash・全ファイル照合・旧164ファイルの保全を記録します。raw録画、コード入り審査手順、認証情報、私的ログ、モデルやフォントは16ファイルのallowlistに含まれません。投稿用本編・画像4枚・PDFを選ぶ際は新しいmanifestを使い、保全した旧版を混ぜません。
