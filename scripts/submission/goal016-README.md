# Goal016 制作手順

新しい公開UIから実AI1依頼を収録し、その候補・採用・PDF・ガイド・保存再開を同じ作品として編集する。旧Goal014/015/reviewの画面、録画、原稿は今回の入力にしない。これらのスクリプトはアプリAPI・Cloud・モデルに接続しない。実収録は別の一度限りのdriverと運用担当が行う。

原本は `artifacts/goal016/before/preservation.json`。54件などの件数をコードに固定せず、列挙された全ファイルのサイズとhashを梱包の前後で照合する。素材はGit管理外。制作コードだけを通常main統合する。

## 新収録の契約

収録先は `artifacts/submission/private/goal016-final/capture/<timestamp>/`。正本 `capture.json` は `goal016-media.mjs` の `validateCaptureShape()` / `loadCapture()` に従う。

- `format: ugoku-goal016-capture-v1`、実公開source SHA・revision・digest・originを記録する。
- 実Vertex1依頼、1〜6モデル送信。承認後の `run-final.json` と採用プロジェクトをhashで照合する。模擬応答・手動支援・未採用を成功に置き換えない。
- 4画像は `selection/request/comparison/print`。requestとcomparisonは原本の版、printとPDFは採用版。selectionは同じ作品の途中版でもよい。
- 原録画に私用設定区間が含まれる場合、公開可の `usableStartSeconds` / `usableEndSeconds` だけをclipsに登録する。`credentialFree` はこの区間の意味で、原録画全体の宣言ではない。安全マーカーを使い、実PTSを確認する。
- 動画・画像・PDF・run・設計・eventsのfileはcapture.jsonと同じディレクトリ以下の相対パス。symlinkや外部pathは受け付けない。
- 比較／採用／同版PDF／取得版guide／保存再読込が揃わない場合はfailedとして保全する。この入口を通すための追加推論は自動実行しない。

## 収録後のローカル工程

```bash
export GOAL016_ASSETS=/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission
node scripts/submission/goal016-selfcheck.mjs
node scripts/submission/goal016-capture.mjs --assets-root "$GOAL016_ASSETS" --capture "$GOAL016_CAPTURE/capture.json"
node scripts/submission/goal016-architecture.mjs --assets-root "$GOAL016_ASSETS"
node scripts/submission/goal016-video.mjs --assets-root "$GOAL016_ASSETS" --plan "$GOAL016_ASSETS/private/goal016-final/video-plan.json"
node scripts/submission/goal016-review.mjs --assets-root "$GOAL016_ASSETS"
```

`video-plan.json` は完成capture SHAへ結び付ける。`edition/captureManifest/captureSha256/editingNote/scenes[]` を持ち、各sceneは `id/kind/clipId/sourceStart/duration/playbackRate:1/label/caption`。静止は `imageRole` と5秒以下のduration、「静止」を含むlabelを使う。入力パスを自由指定せず、登録済みclip/imageだけを参照する。25fpsに整列した実PTSで編集し、待機省略・区間の切替はeditingNoteに記録する。撮影直後に見せていない入力操作・連続撮影・実物成功を追加しない。

レビューは全decode、各scene中点・全境界前後の実フレーム抽出、contact作成、loopbackのみの1倍全編再生を行う。既存reviewディレクトリがあれば停止。目視は別途行い、実際に見た範囲だけを `private/goal016-final/acceptance.json` に記録する。

## ローカル音声

既存の公式VOICEVOX Nemo 0.24.0、女声1（10005）を使用できる。既存 `narrate.py` の音声処理を読み込むが、Goal015の原稿・尺・動画は使わない。音声エンジンを自動起動・取得せず、外部音声APIへ接続しない。

`goal016-narration-draft.json` は時刻なしの草稿。実際の新しい結果と最終EDLを見て `narration-plan.json` を作る。`edition/sourceSha256/captureSha256/durationSeconds/segments[]` を持ち、segmentsには `id/sceneIds/startSeconds/untilSeconds/text/spokenText` を記録する。話速1.0、音高0、抑揚1.0。収まらない場合は短文化し、加速や切り詰めをしない。

```bash
python3 scripts/submission/goal016-narrate.py \
  --source "$GOAL016_ASSETS/public/goal016-final/demo.mp4" \
  --edl "$GOAL016_ASSETS/private/goal016-final/video/edit-decisions.json" \
  --plan "$GOAL016_ASSETS/private/goal016-final/narration-plan.json" \
  --work "$GOAL016_ASSETS/private/goal016-final/narration/render" \
  --out "$GOAL016_ASSETS/private/goal016-final/narration/output"
node scripts/submission/goal016-narration-review.mjs \
  --movie "$GOAL016_ASSETS/private/goal016-final/narration/output/demo-narrated.mp4" \
  --source "$GOAL016_ASSETS/public/goal016-final/demo.mp4" \
  --manifest "$GOAL016_ASSETS/private/goal016-final/narration/output/manifest.json" \
  --out "$GOAL016_ASSETS/private/goal016-final/narration/review"
```

字幕を含む全映像packet・時刻の一致、PCM信号、非クリップ、発声区間、音声有効1倍全編再生を測定する。客観検査と耳での聴感確認は別。助手が実聴できない場合は未確認のまま明記する。クレジットは「音声：VOICEVOX Nemo（女声1）」。[規約](https://voicevox.hiroshiba.jp/nemo/term/)とクレジットを配布先・YouTube説明欄へ引き継ぐ。

## 梱包は2段階

1. `acceptance.json` に `accepted:true/videoSha256/images:[{file,sha256}]/architectureSha256/visual` を記録する。Dropがあれば実際のレビュー結果も記録する。最終main/CIは別の `integration-status.json` に記録でき、撮影時SHAへ付け替えない。
2. `goal016-package.mjs --assets-root "$GOAL016_ASSETS" --mode stage`。新しい本文・README・manifestを固定し、`package-candidate.json` に公開全ファイルのhashを列挙する。旧ファイルや別名ファイルの混入は拒否する。
3. 審査コードを扱う権限を持つ親担当だけが、候補全バイトと実画像を確認する。`secret-scan-attestation.json` に `format:'ugoku-goal016-secret-scan-v1',result:'passed',candidateSha256,files`（候補と同一順序のfile/bytes/sha256一覧）、`knownCredentialByteScan:true,secretValuesPrinted:false,visualNoCredential:true` を記録する。梱包コード自身は秘密を読まない。
4. `goal016-package.mjs --assets-root "$GOAL016_ASSETS" --mode seal`。候補・scan・旧素材を再照合し、ZIPを排他的作成、全件展開してバイト一致を確かめる。

出力は `public/goal016-final/` と `ugoku-kami-goal016-final.zip`。既存の候補・生成物・ZIPがあれば上書きせず停止する。再編集は旧結果を別名へ明示保全してから行い、scanと検査を新しいhashに結び直す。YouTube投稿・Zenn提出・実物試作はこの工程では行わない。
