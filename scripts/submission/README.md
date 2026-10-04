# 提出素材の収録と編集

これらのスクリプトは公開前の素材をローカルで準備します。デプロイ、外部サービスへのアップロード、YouTube掲載、フォーム送信は行いません。素材の存在と公開環境の確認は別です。`manifest.json` は公開URLとYouTube URLを実確認するまで `LOCAL_DRAFT` のままです。

Node 24、依存関係、Chromium（Playwright）、ffmpeg/ffprobe（libx264・libass）、Noto Sans CJKフォント、Python 3（標準zipfile）が必要です。モデルの導入やダウンロードは行いません。

```sh
npm ci
npm run build
node --import tsx scripts/submission/prepare.ts --out artifacts/submission
node --import tsx scripts/submission/capture.ts --mode manual-rehearsal --out artifacts/submission
```

リハーサルは `AI_PROVIDER=none` で、AI実行ボタンを押しません。サーバーは空いているループバックポートを使い、終了時に自分が作ったプロセスだけ閉じます。リハーサルの動画・スクリーンショットは私的記録だけに残ります。

実AIの収録は、明示的に認められた一回のローカル実行に限ります。使うソースを固定してビルドし、Ollamaのモデル・digest・上限を既存の環境ファイルで指定します。`--env` は秘密そのものではなくファイルパスです。Geminiや模擬providerは受け付けません。

```sh
node --import tsx scripts/submission/capture.ts --mode local-ai --env /absolute/private/local.env --out artifacts/submission
```

既に起動している同じ固定ソースのアプリを使うときは `--origin http://127.0.0.1:PORT --source-sha SERVED_COMMIT_SHA` を指定します。ソースSHAとビルドの一致を収録前に確認してください。

通常の製品画面で自作魚画像を読み込み、矩形・寸法・紙上限を設定し、候補を比較・採用します。HTTP応答の差替え、DOMへのAI回答挿入はありません。選択領域の最後の数値調整も画面の通常入力です。20→25mmの有効な候補が得られなければそこで失敗を残し、成功映像を作りません。再実行は自動で行いません。

`private/recording/local-ai-*/capture.json` と動画ができたら、そのファイルを指定します。

```sh
node --import tsx scripts/submission/assemble.ts --capture /absolute/path/capture.json --out artifacts/submission
node --import tsx scripts/submission/review.ts --out artifacts/submission
node --import tsx scripts/submission/package.ts --out artifacts/submission
```

録画の前後に、製品とは別の非公開ページで2色の同期マーカーを記録します。WebMの実フレームから時刻差とドリフトを測り、製品画面やAIの回答へDOMを挿入しません。マーカー・設定画面は公開編集から除きます。同期誤差が大きい場合は編集を止めます。

編集は実動画から切り出した11区間、等速、計180秒です。AI待ち時間の省略を字幕に明記します。設定画面と非公開の記録書出しは含めません。ナレーション・音楽・生成映像は追加しません。字幕は別SRTにも残します。手動70mmの失敗例には手動と字幕で明記し、AIの応答と混ぜません。

`review.ts` は全フレームのデコードと、ブラウザでの180秒の等速通し再生、1秒ごとのコンタクトシートを出します。これだけで目視済みとは記録しません。担当者が全字幕区間・場面転換・画像4枚を実際に見て、文字の欠け、字幕の被り、秘密の露出、設計版の対応を確認し、レビュー結果を追記します。実物工作や初見ユーザーの確認として扱いません。

公開ZIPは決められた文・構成図・画像4枚・字幕・説明・manifestだけを含みます。MP4は別添です。raw動画、実行記録、プロジェクト、型紙、モデル、フォント、環境ファイルはZIPへ入りません。型紙PDF/SVGと採用プロジェクトは `private/recording` に残り、同じ版を実物試作へ引き渡せます。

## 成功収録後の確認

- `capture.json` が実ローカルの `REAL_LOCAL_AI_CAPTURED` で、通常のrun POSTが1回であること。過去の失敗収録は削除せず、同じ成果や成功率として合算しない。
- 公式UIから取得した `ai-evidence.json` の採用状態・runId・designId/revision/hashが `adopted.ugoku.json` と一致すること。未採用の画像02は候補の版、画像01は基準の版として区別する。
- 全PDFページがA4で、メタデータに採用版のID・revision・hashがあること。全体版と分割版をレンダーして、切断線・50mm校正線・部品・接着面を確認する。字幕の「同じ設計版」はこの取得版を指す。
- `edit-decisions.json` で全シーンの操作終了が切り出し内にあること。採用・ダウンロード・再開のクリック結果が実動画で読めること。末尾を切る必要があれば、他区間の余白と配分を調整して180秒を保ち、編集を記録する。
- 待機を削った秒数と実際の待ち時間を混同しない。ローカル実行であること、手動70mmがAIの提案ではないことを字幕で確認する。
- 等速で全編を通し再生し、全フレームをデコードする。1秒間隔の9枚のコンタクトシート、全字幕区間、場面転換、4枚の画像を目視する。小さな文字は該当時刻の原寸フレームで確認する。全フレームを人が一枚ずつ目視したとは記録しない。
- パスワード設定、個人ファイル名、内部パス、秘密、架空のURL、実物確認済みという表現が公開範囲へ入っていないこと。公開URL・YouTube URL・フォームカウンターは未確認なら未確認のまま残す。
- 手動70mm→元に戻すは設計内容のhashを戻す一方、revisionは進む。動画終盤の現在版を、先に取得したPDFの版へ書き替えない。

## 実物キットの入口（担当者への引き渡し）

成功した収録フォルダの `adopted.ugoku.json`、`ai-evidence.json`、`actual-run.json`、`kit.pdf`、`pattern.pdf`、`instructions.pdf`、`pattern.svg` を使います。失敗した収録や未採用候補をキットの採用版として扱いません。別の空フォルダへブラウザ取得ファイルをコピーして原本を保持します。

既存の `scripts/prepare-prototype.ts` が公開する `writePrototypeBundle(project, { outDir, mode: 'live-ollama', liveRunId })` に、この採用プロジェクトと実runIdを渡すと、同じ版の材料表・部品表・工程図・正面の予定図・空欄の実物記録を作れます。これは準備であり、印刷・組み立ての代行や実施報告ではありません。関数はブラウザの `kit.pdf` を上書きせず、別の `core-kit.pdf` として準備用PDFを保存します。

100%印刷の50mm校正線、C1とガイドの表裏接着、始点・途中・終点、10往復程度、切り直しや手修正は、実際に試してから記録します。予定図を実物写真として使わず、記録が空欄のままでも完成したことにしません。
