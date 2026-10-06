# Zenn提出素材：review-v2.1

**最新版は `review-v2.1` です。** 提出するファイルの一覧は、ローカルの `artifacts/submission/public/goal011/review-v2.1/README.txt` を基準にします。`review-v2` と以前のGoal011素材は保全した旧版です。

実保存先は `/home/mhirotaka/workspace/ugoku-kami-studio/artifacts/submission/`。画像・MP4・PDF・本文・構成図・ZIPは既存方針どおりGit管理対象外で、GitHub上にはありません。Gitには制作コード、確定コピー、この手順、[変更記録](../../docs/submission-redesign-012.md)だけを統合します。秘密・生ログ・artifacts全体を強制追加しません。

| Zennで使うもの | `public/goal011/review-v2.1/` 内のファイル |
|---|---|
| 画像1：自分の絵から工作へ | `images/01-from-your-art.png` |
| 画像2：あと5mm・紙1枚を保持 | `images/02-five-more-millimeters.png` |
| 画像3：AI提案・コード検査・作者採用 | `images/03-compare-and-choose.png` |
| 画像4：同じ採用版の原寸キット | `images/04-full-size-kit.png` |
| 動画 | `demo.mp4` — 177.12秒、FHD/25fps/無音。投稿後の実URLを動画欄へ |
| 課題と解決 | `problem-solution.txt` |
| アーキテクチャ説明 | `architecture.txt` |
| 既存構成図 | `architecture.png`（同一内容の`architecture.svg`も同梱） |
| 素材一覧・出所・版 | `README.txt`、`manifest.json` |

一式ZIPは `artifacts/submission/ugoku-kami-goal011-review-v2.1.zip`。上記の素材に字幕・既存PDF・実物確認手順を含みます。投稿・最終提出・新しい推論・デプロイはこの制作作業に含めません。

## 冒頭だけの変更

最初の10秒は、同じ実AI作品の基準25mm画面、25→30mmの候補比較、採用した30mm第3版のPDFとガイドを静止抜粋で紹介します。連続操作とは扱わず、その後の手動デモも別セッションとして表示します。重複する選択確認を2秒短縮し、総尺177.12秒を維持。33秒以降の映像、4画像、本文2欄、構成図、既存PDFは旧review-v2と同一です。

## 保存済み素材からの再生成

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

以前のローカルGemma収録手順は [過去の収録資料](legacy-local-recording.md) に保全しています。今回の最新版の再生成には上記の手順を使います。
