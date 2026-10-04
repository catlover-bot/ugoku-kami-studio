# AI接続の設定と限定確認

## Goal 007-R: ローカルGemmaを使う

今回はホスト型推論APIを呼ばない。`AI_PROVIDER=none|ollama|gemini` が唯一の選択設定で、未設定は `none`。旧 `AI_ENABLED=true` や保存済みGoogleキーだけではAIを有効にしない。`ollama` が失敗してもクラウドへ切り替えない。Geminiの既存アダプターと限定試験は残すが、今回の対象外。

このWSLでは既存の `/home/mhirotaka/.local/opt/ollama-0.33.3/bin/ollama` を再利用した。選定モデルは **`gemma4:e2b-it-qat` / Q4_0**、manifest digestは `07ea59a474013479c8b6b802bef095c40e964a1d776ba02f264c0e30e1aede0c`。タグの必要版は0.30.5以上だが、アプリのローカル限定・履歴切捨て禁止のAPI仕様は0.33.3で確認したため、アダプターの最低版は0.33.3。モデルは[Apache 2.0](https://ai.google.dev/gemma/apache_2)、正確な容量・量子化は[公式タグ](https://ollama.com/library/gemma4:e2b-it-qat)を確認した。E2Bは実効パラメーターの名称で、ローカルmetadataは4.6B、画像用projectorも含む。

専用モデル保存先は `/home/mhirotaka/.local/share/ugoku-kami/ollama-models`。他プロジェクトのモデルや設定を変更していない。標準pullは既存の鍵設定で `ssh: no key found` となったため、その設定を保持し、公式レジストリの同一manifestと全blobを匿名HTTPSで取得して各SHA-256を照合した。取得本文は **4,336,359,085 bytes / 176.076秒**（manifest・config込み、HTTP/TLS overheadは含まない）。重み・configのディスク上の合計は4,336,358,185 bytes。初回取得は外部通信であり、推論時のローカル通信と区別する。取得手順と失敗を含む記録は `artifacts/goal007r/model-{pull,download}-result.json`、実モデル情報は `runtime-model-metadata.json`。

この作業で専用の `.env.ollama`（権限0600、Git対象外）を作成した。既存 `.env` は上書きしていない。現在の設定は `AI_PROVIDER=ollama`、明示接続先 `http://127.0.0.1:11434`、上記タグとdigest、並列1。実入力で8192を試したところ、ツール往復後の9346トークンを切捨て禁止により拒否したため、現在の明示設定は16384。必要な履歴を切り捨てない。`OLLAMA_TOOL_MODE=json-actions` を明示し、許可ツールへのJSONアクションを同じ検査・承認経路で実行する。ネイティブ方式は実試験で候補を作れなかったため、成功とは記録していない。方式を自動で切り替える実装はない。`AI_ACCESS_SECRET` は画面の「設定」へ入力するアクセスコードで、Googleキーではない。値はチャット・スクリーンショット・Gitへ出さず、ローカルのエディタで確認する。

Ollamaが停止している場合だけ、別のターミナルで次を実行する。既に起動中なら重複起動しない。

```sh
cd /home/mhirotaka/workspace/ugoku-kami-studio
OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 \
OLLAMA_MODELS=/home/mhirotaka/.local/share/ugoku-kami/ollama-models \
OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_CONTEXT_LENGTH=16384 \
/home/mhirotaka/.local/opt/ollama-0.33.3/bin/ollama serve
```

別ターミナルで状態と設定を確認し、アプリを起動する。

```sh
cd /home/mhirotaka/workspace/ugoku-kami-studio
curl --noproxy '*' --fail http://127.0.0.1:11434/api/status
curl --noproxy '*' --fail http://127.0.0.1:11434/api/tags
UGOKU_ENV_FILE=.env.ollama npm run doctor
npm run build
HOST=127.0.0.1 PORT=4187 UGOKU_ENV_FILE=.env.ollama npm start
```

`http://127.0.0.1:4187` を開く。4187は今回の専用ポートで、既存の開発サーバーは停止していない。

`/api/status` の `cloud.disabled` が `true` であることを、アプリもモデル要求前に毎回確認する。接続先はポートを明示した127.0.0.1または[::1]だけを受け付け、HTTP redirect、クラウドタグ、リモートモデルmetadata、指定digest不一致を拒否する。ブラウザから接続先を指定する機能はない。Ollama自身のクラウド無効化とloopback設定については[公式FAQ](https://docs.ollama.com/faq)を参照。

通常画面の「動きをつける」で希望を一度入力し、「寸法から案をつくる」か「AIで案をつくる」を選ぶ。「設定」にアクセスコードとモデル情報・実行記録をまとめている。ドラッグ、再生、スライダー、自動保存は推論を起動しない。AIの候補は採用するまで作品を変更せず、採用・印刷も同じ設計版の決定的コアを使う。

明示的なローカル試験は以下。モデル取得・起動は自動実行せず、通常CIからも呼ばない。有料API用の許可フラグは不要。

```sh
npm run build
UGOKU_ENV_FILE=.env.ollama npm run smoke:local -- --plan
UGOKU_ENV_FILE=.env.ollama UGOKU_OLLAMA_PID=506729 npm run smoke:local -- --case all
```

PIDは今回起動したプロセスの値で、再起動後は `ss -ltnp 'sport = :11434'` のOllama PIDへ置き換える。PIDを指定しない場合、プロセスRSSは未測定と記録する。`--plan` は通信0回。実行時は通常UI→実サーバー→実Ollamaを使い、同一入力の手動支援と比較する。各試行のロード・入力処理・生成時間、メモリ、失敗、採用版PDFを `artifacts/goal007r/local/` の新しいディレクトリへ保存する。モデルファイルの容量、実行時RAM、コンテキストメモリは別物であり、この数値を混同しない。

今回の実測では、候補／結果までL1（20→25mm）78.221秒、L2（70mm不成立）72.169秒、L3（回転せず右へ）52.111秒。同入力の手動支援は0.072/0.126/0.062秒だった。L1は採用後の同版PDF全5頁を目視し、手動版と全ページの画素が一致した。L2でモデルが示した50mmの条件変更案も別途コア再検査では不成立だった（手動代案42mmは成立）。条件変更案は未検査の助言と表示し、自動適用しない。実モデルを使えたことと、全ての助言が正しいことを区別する。失敗、CPU競合、個別のロード/入力/生成時間、RSSと測定上の限界は [Goal007-R記録](goals/007r-local-ai-clean-ui.md) と `artifacts/goal007r/evidence-aggregate.json` を参照。

WSLローカル動作は、指定Google Cloud実行プロダクトやデプロイURLの要件を満たした証拠ではない。Cloud Runのlocalhostから利用者のWSLへは接続できない。トンネル・ポート開放・クラウド公開は行っていない。モデルAPI課金がないことと、端末・電力・保存や将来の公開費用がないことは別である。

## 既存の実Gemini接続（今回は無効）

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
| `AI_PROVIDER` | 初期は`none`。別途許可されたGemini実行時だけ`gemini`。キーの存在だけでは有効にならない |
| `AI_ACCESS_SECRET` | Googleキーとは別の32文字以上のアクセスコード |
| `AI_MAX_MODEL_CALLS` / `AI_MAX_TOOL_CALLS` | 初期6 / 12。設定可能範囲1–12 / 1–24 |
| `AI_TIMEOUT_MS` | 初期90000。100–180000 |
| `AI_MAX_INPUT_BYTES` | 初期65536。8192–262144。毎回の全履歴・system・tool定義・設定を含むUTF-8 JSON容量 |
| `AI_MAX_OUTPUT_TOKENS` | 初期4096。256–8192。SDKの`maxOutputTokens`へ渡す |
| `AI_MAX_CONCURRENT` | 初期1。1–5 |
| `AI_RUNS_PER_MINUTE` / `AI_MAX_RUNS_PER_HOUR` | 初期6 / 60。1–30 / 1–120 |
| `PORT` | 通常サーバーは3001。限定smokeは専用localhostの一時ポート |
| `LIVE_API_AUTHORIZED` | `.env`では有効にせず、本人の許可後、そのコマンド起動時だけ`yes`。CLIの許可フラグも必要 |

設定値だけを確認する:

```sh
npm run doctor
npm run smoke:live -- --plan
```

doctorは秘密の有無、選択モデル、読込ファイル、実行上限、設定エラーを示す。キーの文字列やSDKエラー本文を表示しない。APIへ一切問い合わせないため、権限・モデル利用可否・残高は`not-tested`。`AI_PROVIDER=none`でdoctorが通るのは手動利用できるという意味で、ライブ準備完了とは表示しない。

## 本人の許可後に行うこと

最初は**L1を1件だけ**実行する。下記コマンドは明示許可後に本人が使用するもので、現時点では未実行。

```sh
npm run build
LIVE_API_AUTHORIZED=yes npm run smoke:live -- --case L1 --authorize-paid-api
```

L2/L3が必要になった場合も、L1の採用・PDF確認が成功した後に、`--case L2`または`--case L3`を個別指定する。バッチ実行・自動再試行はしない。smokeは本番のサーバー、実Geminiアダプター、ブラウザ、候補採用、PDF出力を通す。実行前の計画と記録は`artifacts/goal004/`へ保存する。通常のAPI設定は共通ファイルから読むが、ライブの許可フラグは`.env`から読み込む前に判定し、その起動時に指定された許可だけを使う。

- **L1**: 「もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない」。現在値から増える余地のある固定サンプルを使い、ツール・候補・保護条件・採用版・PDFを照合する。固定の20→25mm回答では判定しない。
- **L2**: サンプルの本当の幾何制約と両立しない希望を使う。failの実検査結果、代案または条件変更の説明、現在版の保持を確認する。失敗を演出しない。
- **L3**: 「回転させたい」。通常の画面からサーバーへ依頼し、明確な非対応動作をHTTP 422 `unsupported_motion` でモデル呼出し前に拒否する。手動パーサーで画面からの送信を止める方式とは区別する。設計を保ち、0モデル呼出しであることを実Gemini応答の成功に数えない。

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

`run.mode`は`ollama`、`gemini`または`injected-test`、`run.model`は設定モデル。各`modelUsage`に送信試行、入力byte数、出力上限、所要時間、受信有無、finishReason、返されたmodelVersion、使用量を残す。prompt/output/thinking/cached input/tool prompt/totalを区別する。使用量が返らない呼出しは`usage:null`と`responsesWithoutUsage`で不明として残し、0円とは扱わない。内部思考・thoughtSignature・認可トークン・アクセスコード・画像本体は公開記録へ含めない。

モデルContent全体、functionCallのID、opaqueなthoughtSignatureはサーバー内で保持し、実行したtoolの結果を次の要求へ返す。返答だけで成功とせず、候補作成・最終候補・採用を決定的コアで検査する。Goal006の構造化した解釈提案も同じツールループと上限を使う。手動で読み取れない言い方はAI経路へ渡せるが、固定条件や承認の保護は緩めない。未解決の重要条件は訂正待ちとし、明確な非対応動作だけはモデル呼出し前に拒否する。[公式function calling](https://ai.google.dev/gemini-api/docs/function-calling)

- `provider_auth`: 既存キーの権限・制限・対象APIを所有者が確認する。エラーを直すためのIAM変更を自動実行しない。
- `provider_rate_limit`: API側429。時間を置き、残る限定枠を確認してから手動再試行する。
- `input_limit`: 履歴が設定byte上限を超えたため、その回はGoogleへ送信していない。上限を黙って増やさない。
- `timeout` / `invalid_output` / `model_limit` / `tool_limit`: 元の設計を保持。成功件数へ加えず記録を確認する。

通常の`npm run check` / `npm run test:e2e` / CIは実APIを呼ばない。実SDKのwire-format検査もfetchをローカルで捕捉する試験であり、Googleへの到達を検証したものではない。
