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

編集は実動画から切り出した11区間、等速、計180秒です。AI待ち時間の省略を字幕に明記します。設定画面と非公開の記録書出しは含めません。ナレーション・音楽・生成映像は追加しません。字幕は別SRTにも残します。手動70mmの失敗例には手動と字幕で明記し、AIの応答と混ぜません。

`review.ts` は全フレームのデコードと、ブラウザでの180秒の等速通し再生、1秒ごとのコンタクトシートを出します。これだけで目視済みとは記録しません。担当者が全字幕区間・場面転換・画像4枚を実際に見て、文字の欠け、字幕の被り、秘密の露出、設計版の対応を確認し、レビュー結果を追記します。実物工作や初見ユーザーの確認として扱いません。

公開ZIPは決められた文・構成図・画像4枚・字幕・説明・manifestだけを含みます。MP4は別添です。raw動画、実行記録、プロジェクト、型紙、モデル、フォント、環境ファイルはZIPへ入りません。型紙PDF/SVGと採用プロジェクトは `private/recording` に残り、同じ版を実物試作へ引き渡せます。
