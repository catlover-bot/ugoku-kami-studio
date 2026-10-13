# 操作と得られるものを伝える紹介素材 — 内部制作手順

投稿用のファイルは `public/goal016-value-first/demo-full-narrated.mp4`。公開READMEは掲載するファイルだけを短く案内し、制作・検証・出所の説明はこの手順と非公開記録へ分けます。新版は163.04秒（2分43.04秒）・4,076フレーム・18場面・17音声区間で完成しました。

新版の無音版・音声版とも全編デコードと1倍再生が成功し、drop/corruptは0。字幕18件の本文・時刻、音声付き動画の全4,076映像packet一致、独立した目視を確認しました。音声の客観検査は成功し、耳での聴感確認は未実施です。根拠は `private/goal016-value-first/` の動画・音声レビューと独立目視記録へ保存しています。秘密検査後のZIP生成・17件の展開照合は `package-result.json` を正本とし、動画の検査完了から梱包完了を推定しません。

## 公開する17ファイル

標準の素材ルートは `/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission`。公開先は `public/goal016-value-first/`、ZIPは `ugoku-kami-goal016-value-first.zip` です。

| 掲載欄・用途 | ファイル |
|---|---|
| YouTube投稿用動画 | `demo-full-narrated.mp4` |
| 無音映像・字幕・音声原稿 | `demo-full.mp4` / `captions.srt` / `narration-timed.txt` |
| タイトル・概要欄・音声クレジット | `youtube-description.txt` / `youtube-audio-credit.txt` |
| 画像4枚 | `images/01-select-your-art.png` / `02-describe-the-motion.png` / `03-compare-the-ai-proposal.png` / `04-print-the-adopted-version.png` |
| 画像の見出し | `image-descriptions.txt` |
| 課題と解決・構成の説明 | `problem-solution.txt` / `architecture-description.txt` |
| 構成図 | `architecture.png` |
| 採用設計のPDF | `adopted-same-version.pdf` |
| 公開操作案内・掲載案内 | `review-instructions-public-note.txt` / `README.txt` |

公開manifestは作りません。詳細manifest・生録画・出所・検査・CI・ZIP照合は `private/goal016-value-first/` へ保存します。審査用コードは既存の `private/goal016-final/reviewer-instructions.txt` だけに保ち、公開ZIPには含めません。

## 原本と編集範囲

既存の実AIによる20→25mm・第2版の採用記録と、同じ採用正本を開く既存の手動録画を使います。送った希望文は「右へ25mm動かしたい。絵の大きさと紙の枚数は変えない」のままです。実AIの再実行、Cloud操作、再デプロイ、アプリ変更は行いません。制作状況を説明する旧テロップは、元の安全な録画から映像を再出力して差し替えます。UIの数値・検査結果・注意書きを塗り替えません。

4画像は元の実画面と同一バイトで継承します。画像に自前の制作テロップがないことを確認しました。PDFも同じ採用版の原本を継承します。構成図は元SVGの下端にある制作注記一つだけを除去し、図の内容・配置・色・文字を保ちます。出所と差分は `static/provenance.json` に記録します。

旧36.08秒版、旧163.04秒版、両版の非公開資料とZIPは、作業前の `preservation.json` に751ファイルとして固定しています。旧ファイルを削除・上書きせず、新しい成果物だけを追加します。新規作成が途中で失敗しても部分出力と失敗記録を保全し、暗黙に再実行・置換しません。

## 再生成

Node24、既存依存、Playwright Chromium、Python3、ffmpeg/ffprobe、pdftoppmと既存VOICEVOX Nemo Engine 0.24.0を使います。Nemoは `127.0.0.1:50121` だけで動かし、女声1・標準速度1を維持します。外部音声APIは使いません。この手順はGitHubのソースだけから私的録画を復元するものではなく、固定済みの素材と指示書が必要です。

```bash
export VALUE_ASSETS=/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission
export VALUE_WORK="$VALUE_ASSETS/private/goal016-value-first"
export VALUE_PUBLIC="$VALUE_ASSETS/public/goal016-value-first"
export VALUE_PREPARED="$VALUE_WORK/narration/prepared-v2"
```

`VALUE_PREPARED` は採用した最終原稿と一致する計測ディレクトリです。以下は未生成の出力先で実行する手順で、完成済みのディレクトリへ繰り返し実行しません。

1. 公開コピーと静的ファイルを生成します。原稿は `value-copy.json`、YouTube概要欄は同封指示の原本を使います。

```bash
node scripts/submission/value-static.mjs --assets-root "$VALUE_ASSETS"
```

2. `full-script.value-first.json` の新しい17章を計測します。長い場合は原稿を短くして新しい計測ディレクトリへ保存し、速度変更や語尾の切り詰めでは調整しません。

```bash
python3 scripts/submission/value-prepare-narration.py \
  --script scripts/submission/full-script.value-first.json \
  --out "$VALUE_PREPARED"
```

3. 実測した発話と元映像の安全なPTS区間から `video-plan.json` を確定します。内部のscene IDと出所を保ちつつ、字幕・上部ラベルは利用者の操作名へ変更します。最後は採用作品またはキット全体を示します。

```bash
node scripts/submission/value-video.mjs \
  --assets-root "$VALUE_ASSETS" --plan "$VALUE_WORK/video-plan.json"
node scripts/submission/value-review.mjs --assets-root "$VALUE_ASSETS"
```

4. 完成EDL・凍結原稿・採用した計測manifestから音声計画を生成します。各章の前後に0.10秒の余白を置き、実測した音声が収まることを確認します。元WAVの先頭0.18秒・末尾0.25秒の設定も維持します。

```bash
python3 scripts/submission/value-narration-plan.py \
  --edl "$VALUE_WORK/video/edit-decisions.json" \
  --script scripts/submission/full-script.value-first.json \
  --prepared "$VALUE_PREPARED/manifest.json" \
  --out "$VALUE_WORK/narration/plan.json"
python3 scripts/submission/value-narrate.py \
  --source "$VALUE_PUBLIC/demo-full.mp4" \
  --edl "$VALUE_WORK/video/edit-decisions.json" \
  --plan "$VALUE_WORK/narration/plan.json" \
  --prepared "$VALUE_PREPARED" \
  --work "$VALUE_WORK/narration/work" --out "$VALUE_WORK/narration/output"
node scripts/submission/value-narration-review.mjs \
  --movie "$VALUE_WORK/narration/output/demo-full-narrated.mp4" \
  --source "$VALUE_PUBLIC/demo-full.mp4" \
  --manifest "$VALUE_WORK/narration/output/manifest.json" \
  --out "$VALUE_WORK/narration/review"
```

音声はstream copyした同じ映像へ追加し、字幕と映像packetが変わっていないことを検査します。公開音声原稿には内部IDや読み指定を載せません。Nemoのクレジットは動画の概要欄にも引き継ぎます。全編再生・音声信号・同期の客観検査と、耳での聴感確認は別です。

5. 完成した新ファイルを目視し、字幕の見切れ、章と説明の対応、UI自身の注意が維持されていることを確認して `acceptance.json` に記録します。通常main統合・push後、同じmain SHAのCheckとWebKit成功を `integration-status.json` へ保存します。配信したアプリの版とは分けます。
6. packageはstageとsealの二段階です。stageには同SHAのCI成功が必要です。

```bash
node scripts/submission/value-package.mjs --assets-root "$VALUE_ASSETS" --mode stage
```

stage後、権限を持つ担当が同じ17ファイルの秘密値検査・目視を行い、`secret-scan-attestation.json` に候補hashと同じ順序のfile/bytes/sha256を固定します。コードの値自体は記録・表示しません。その後にsealします。

```bash
node scripts/submission/value-package.mjs --assets-root "$VALUE_ASSETS" --mode seal
```

ZIPは新規作成し、17件全てを展開してバイト照合します。詳細は非公開の `manifest.json`・`package-result.json` に保存します。旧版の成功記録を新版へ付け替えず、YouTube投稿・Zenn最終提出・実物確認を素材生成から推定しません。これらの制作・検証上の区別を公開紹介コピーへ再び混ぜません。
