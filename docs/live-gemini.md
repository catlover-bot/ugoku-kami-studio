# 実Geminiの設定と限定確認

確認日: **2026-10-04**。実APIはまだ呼んでいない。下記のdoctor、plan、通常のcheck/E2E/CIは接続成功の証拠ではない。実物・初見参加者の確認とも区別する。

## 接続方式とモデル

このアプリはサーバーの `@google/genai` **2.27.0** から **Gemini Developer API** の `models.generateContent` を使う。公式の `https://generativelanguage.googleapis.com/v1beta` に固定し、Vertex AI、ADC、Cloudプロジェクト自動作成へ切り替えない。SDK、API、権限を別系統へ作り直していない。[公式 generateContent API と JavaScript の例](https://ai.google.dev/api/generate-content)

既定値 `gemini-3.8-flash` は安定モデルとして掲載され、function callingに対応する。公式モデル上限は入力1,048,576、出力65,536トークン。モデルIDが正しいことと、手元のキーでそのモデルに接続できることは別で、後者は未確認。[公式モデル仕様](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)

認証はサーバー内の `GEMINI_API_KEY`。Googleの現行案内は、AI Studioで2026-05-28以降に作成するキーをauthorization keyとし、制限なしの旧standard keyを拒否すると説明している。既存の許可済みキーを使用し、必要な権限の不備は管理者へ確認する。この手順から課金有効化、キー作成、IAM変更、クラウド作成を自動実行しない。[公式キー設定](https://ai.google.dev/gemini-api/docs/api-key)

アプリの `AI_ACCESS_SECRET` はGoogleのキーとは別の、32文字以上のランダムなアクセスコード。ブラウザへ渡すGoogleキーはない。公式SDKが通常読む `GOOGLE_API_KEY`、Vertexフラグ、base URLの環境変数はこのアダプターでは接続先変更に使わない。

## 設定する場所

リポジトリルート `/home/mhirotaka/workspace/ugoku-kami-studio` で実行する。既存の `.env` を上書きせず、未作成なら `.env.example` をコピーしてローカルのエディタで編集する。キーをチャット、コマンドの引数、Git、`VITE_`変数へ入れない。アクセスコードもエディタまたは既存の秘密管理で保存する。

別の既存ファイルを使う場合は `UGOKU_ENV_FILE=/absolute/private/path.env` を環境へ指定する。共通の `loadServerEnv` と `readConfig` をサーバー・doctor・smokeが使う。優先順位は **既存process環境変数 → 選択ファイル**。未指定時は作業ディレクトリの `.env` のみを読み、親ディレクトリや `.env.local` を探さない。明示したファイルがなければ停止する。

| 項目 | 設定例・意味 |
| --- | --- |
| `GEMINI_API_KEY` | 既存の許可済みGoogleキー。空欄のままでは接続不可 |
| `GEMINI_MODEL` | `gemini-3.8-flash`。別モデルへ変えた場合は料金・互換性を再確認 |
| `AI_ENABLED` | 初期は`false`。実行準備時だけ`true`。キーの存在だけでは有効にならない |
| `AI_ACCESS_SECRET` | Googleキーとは別の32文字以上のアクセスコード |
| `AI_MAX_MODEL_CALLS` / `AI_MAX_TOOL_CALLS` | 初期6 / 12。設定可能範囲1–12 / 1–24 |
| `AI_TIMEOUT_MS` | 初期90000。100–180000 |
| `AI_MAX_INPUT_BYTES` | 初期65536。8192–262144。毎回の全履歴・system・tool定義・設定を含むUTF-8 JSON容量 |
| `AI_MAX_OUTPUT_TOKENS` | 初期4096。256–8192。SDKの`maxOutputTokens`へ渡す |
| `AI_MAX_CONCURRENT` | 初期2。1–5 |
| `AI_RUNS_PER_MINUTE` / `AI_MAX_RUNS_PER_HOUR` | 初期6 / 60。1–30 / 1–120 |
| `PORT` | 通常サーバーは3001。限定smokeは専用localhostの一時ポート |
| `LIVE_API_AUTHORIZED` | `.env`では有効にせず、本人の許可後、そのコマンド起動時だけ`yes`。CLIの許可フラグも必要 |

設定値だけを確認する:

```sh
npm run doctor
npm run smoke:live -- --plan
```

doctorは秘密の有無、選択モデル、読込ファイル、実行上限、設定エラーを示す。キーの文字列やSDKエラー本文を表示しない。APIへ一切問い合わせないため、権限・モデル利用可否・残高は`not-tested`。`AI_ENABLED=false`でdoctorが通るのは手動利用できるという意味で、ライブ準備完了とは表示しない。

## 本人の許可後に行うこと

最初は**L1を1件だけ**実行する。下記コマンドは明示許可後に本人が使用するもので、現時点では未実行。

```sh
npm run build
LIVE_API_AUTHORIZED=yes npm run smoke:live -- --case L1 --authorize-paid-api
```

L2/L3が必要になった場合も、L1の採用・PDF確認が成功した後に、`--case L2`または`--case L3`を個別指定する。バッチ実行・自動再試行はしない。smokeは本番のサーバー、実Geminiアダプター、ブラウザ、候補採用、PDF出力を通す。実行前の計画と記録は`artifacts/goal004/`へ保存する。通常のAPI設定は共通ファイルから読むが、ライブの許可フラグは`.env`から読み込む前に判定し、その起動時に指定された許可だけを使う。

- **L1**: 「もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない」。現在値から増える余地のある固定サンプルを使い、ツール・候補・保護条件・採用版・PDFを照合する。固定の20→25mm回答では判定しない。
- **L2**: サンプルの本当の幾何制約と両立しない希望を使う。failの実検査結果、代案または条件変更の説明、現在版の保持を確認する。失敗を演出しない。
- **L3**: 「回転させたい」。既存の非対応判定が呼出し前に拒否し、設計を保つことを確認する。ここで0モデル呼出しになることを、実Gemini応答の成功に数えない。

各実行は最大モデル6回・ローカルtool12回・90秒・入力65536bytes/回・出力4096tokens/回。環境側が厳しければその値を使う。限定確認全体は**再試行を含め3実行・モデル18回・tool36回・AI処理270秒**まで。永続ローカル台帳で開始前に枠を予約し、停止・クラッシュでも自動で枠を復活させない。普通のWebサーバーの時間窓カウンターはプロセス内だけで、サービス全体の料金上限とは異なる。

## 費用の根拠と限界

2026-10-04に確認したDeveloper API **Standard** の単価は、2026-12-31まで入力 **$0.75/100万tokens**、出力 **$3.75/100万tokens（thinkingを含む）**。2027-01-01からそれぞれ$1.50/$7.50。無料枠の適用は仮定しない。このアプリはSearch、Maps、ファイルアップロード、課金キャッシュ、Batch/Flex/Priorityを使用しない。[公式料金](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash)

| 計算用の仮定 | 6モデル呼出し | 18モデル呼出し |
| --- | ---: | ---: |
| 各回input10,000、output+thinking4,096 tokens | 約$0.14 | 約$0.41 |
| 各回input65,536、output+thinking4,096 tokens | 約$0.39 | 約$1.16 |
| モデル公表上限input1,048,576、output65,536を毎回使う想定 | 約$6.19 | 約$18.58 |

計算は`Σ(input×0.75 + (output+thinking)×3.75)÷1,000,000`。税・換算・将来の価格変更は含めない。上の行は**見積用シナリオで、課金額の保証ではない**。UTF-8 byte数は正確なtokensではなく、`maxOutputTokens`をthinking込みの請求上限と断言しない。公式のtokenカウントAPIへの事前通信もdoctorでは行わない。公表モデル上限の行もアプリによるドル単位の課金遮断を意味しない。[生成設定・使用量仕様](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)、[トークン計数](https://ai.google.dev/gemini-api/docs/tokens)

SDKは`attempts:1`を明示して内部再試行を止める。中断はローカルの待機と後続tool/採用を止めるが、送信済み要求の課金取消しを保証しない。[公式retry設定](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpRetryOptions.html)

## 記録とトラブル時

`run.mode`は`gemini`または`injected-test`、`run.model`は設定モデル。各`modelUsage`に送信試行、入力byte数、出力上限、所要時間、受信有無、finishReason、返されたmodelVersion、使用量を残す。prompt/output/thinking/cached input/tool prompt/totalを区別する。使用量が返らない呼出しは`usage:null`と`responsesWithoutUsage`で不明として残し、0円とは扱わない。内部思考・thoughtSignature・認可トークン・アクセスコード・画像本体は公開記録へ含めない。

モデルContent全体、functionCallのID、opaqueなthoughtSignatureはサーバー内で保持し、実行したtoolの結果を次の要求へ返す。返答だけで成功とせず、候補作成・最終候補・採用を決定的コアで検査する。未対応・矛盾は必要に応じてモデル呼出し前に止まる。[公式function calling](https://ai.google.dev/gemini-api/docs/function-calling)

- `provider_auth`: 既存キーの権限・制限・対象APIを所有者が確認する。エラーを直すためのIAM変更を自動実行しない。
- `provider_rate_limit`: API側429。時間を置き、残る限定枠を確認してから手動再試行する。
- `input_limit`: 履歴が設定byte上限を超えたため、その回はGoogleへ送信していない。上限を黙って増やさない。
- `timeout` / `invalid_output` / `model_limit` / `tool_limit`: 元の設計を保持。成功件数へ加えず記録を確認する。

通常の`npm run check` / `npm run test:e2e` / CIは実APIを呼ばない。実SDKのwire-format検査もfetchをローカルで捕捉する試験であり、Googleへの到達を検証したものではない。
