# API・Geminiアダプター

確認日: 2026-10-04。実Geminiへの有料呼び出しは未実施。自動検証はテスト専用の通信モックを使用する。設定・限定実行手順は [live-gemini.md](../../../docs/live-gemini.md)。

## 公式仕様の確認

- [公式SDK一覧](https://ai.google.dev/gemini-api/docs/libraries): JavaScript/TypeScript向け公式SDKは `@google/genai`。この実装は固定した2.27.0を使用する。
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling): 関数定義に従ってモデルが引数を提案し、アプリケーションが実際に検証・実行した結果を返す。モデル出力だけで実行成功としない。
- [SDK Models.generateContent](https://googleapis.github.io/js-genai/release_docs/classes/models.Models.html): `client.models.generateContent({model, contents, config})` を使う。
- [SDK Part](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Part.html): 履歴にはモデルが返したContentを全体で保存し、関数呼び出しID・全Part・不透明なthoughtSignatureをそのまま次の呼び出しへ渡す。内部思考本文はUIとログへ出さない。
- [SDK GenerateContentConfig](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html): `abortSignal` はクライアント側中断であり、送信済み処理の課金取消しを保証しない。
- [SDK HttpRetryOptions](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpRetryOptions.html): SDKの標準再試行回数は初回を含め5回。実行上限を正確に数えるため `retryOptions.attempts: 1` を指定し、裏で再試行しない。
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash): `gemini-3.8-flash` の安定モデルID、画像入力・function calling対応を確認。`GEMINI_MODEL` で変更可能。ただしこのMVPは画像本体をGeminiに送信せず、依頼文と寸法・選択範囲・検査済み設計データのみを送る。
- [Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash): 既存利用者へのアクセス制限があるため新規プロジェクトの既定値に採用しなかった。
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output): JSON Schemaは値・権限の検査を代替しない。このアプリはツール引数をサーバーのZodとコアで再検査する。

## HTTP契約

同一オリジンのみを想定する。セッショントークンは `Authorization: Bearer …`、AI実行開始だけ追加で `X-AI-Access: …` が必要。APIキーはブラウザに渡さない。

| 操作 | パス | リクエストとレスポンス |
| --- | --- | --- |
| 生存確認 | `GET /api/health` | `{status:"ok"}`。`/health` も同じ |
| 接続状態 | `GET /api/status` | `ai.enabled/mode/reason/model/sendsImage` と実行上限。ネットワーク課金なし |
| 画像検証 | `POST /api/images` | `{dataUrl}` → `{image:{id,widthPx,heightPx,mimeType,dataUrl}}` |
| セッション開始 | `POST /api/sessions` | `{document}` → `{sessionId,token,document}` |
| 手動編集同期 | `PUT /api/sessions/:id/document` | `{document}` → `{document}`。同じIDの新しい版が必要 |
| セッション削除 | `DELETE /api/sessions/:id` | `{deleted:true}` |
| AI開始・解釈訂正 | `POST /api/sessions/:id/runs` | `{requestId,prompt,baseRevision,baseHash,correction?}` → HTTP 202 `{run}`。訂正は下記の元依頼・版との照合が必要 |
| 実行取得 | `GET /api/sessions/:id/runs/:runId` | `{run}` |
| 中断 | `DELETE /api/sessions/:id/runs/:runId` | `{run}` |
| 候補採用 | `POST /api/sessions/:id/proposals/:proposalId/approve` | `{requestId,baseRevision,baseHash}` → `{document}` |
| 候補却下 | `DELETE /api/sessions/:id/proposals/:proposalId` | `{run}` |

`run.status`: `running / awaiting_approval / clarification_required / succeeded / failed / cancelled`。未実行状態はUIが管理する。
`run.proposal`: `{id,requestId,baseRevision,baseHash,patch,document}`。
`run.events`: `{sequence,type,tool?,message,designHash?,patch?,checkStatuses?,durationMs}`。
`run.constraintSuggestions`: `{key,value,reason,source,verification}[]`。原本へ信頼済みの希望・直近patchを重ね、指定条件1つだけを仮変更して、既存コアの幾何検査を通る案のみ提示する。`source:model` と `verification.source:deterministic-core`、基準版・比較候補・仮設計のハッシュ、`contextPatch`、検査結果を記録する。不成立はモデルへ実際の理由を返し、表示一覧に加えない。`conditionsApproved:false` の条件付き助言であり、固定条件の解除・原本変更・採用候補への昇格はしない。実物検査のunknownも維持する。利用者が手動で条件を見直す。候補や解釈の変更後は古い検査を破棄する。

生成済み・幾何検査を通過した候補と同じ値の補助助言は `ignored:true` / `reason:unchanged_condition` として返し、候補を保持する。表示する助言や承認は追加せず、以前の別ツールエラーも解消しない。候補未生成、不成立候補、不正な引数に対する同値助言は引き続き拒否する。実行完了時の再検査と本人の採用操作は省略しない。
`run.mode`: `gemini / ollama / injected-test`。実Gemini・実Ollama・テスト注入を区別する。`run.model`は設定したモデル。
`run.usage`: APIが取得できた `promptTokens/outputTokens/thinkingTokens/cachedInputTokens/toolPromptTokens/totalTokens` の合計と、`responsesWithUsage/responsesWithoutUsage`。不明を0円として扱わない。
`run.modelUsage`: 呼出し別の `{call,inputBytes,outputTokenLimit,durationMs,received,finishReason,modelVersion,usage}`。未受信・使用量欠落は`usage:null`。設定上限超過による送信前拒否はmodelCallsを増やさない。

## 境界と制限

- 画像は入力5MiB、各辺8192px、展開後1200万画素まで。PNG/JPEG/WebPのマジックバイトと宣言MIMEを一致させ、Sharpで実際に全デコードし、PNGへ再エンコードする。画像IDは正規化PNGのSHA-256。アニメーション・URL・SVG・HTMLを拒否する。
- 通常JSON本文は256KiB、画像用本文のみ8MiB。画像処理はインスタンスあたり同時2件・20件/分。API全体は600リクエスト/分。公開APIを使ったメモリ消費を制限する。
- `AI_ENABLED` は既定でfalse。有効化にはキーと32文字以上のアクセス秘密が必要。キーがあるだけで有効化しない。
- 初期上限はモデル6回、ツール12回、90秒、同時2件、6実行/分、60実行/時。`AI_MAX_MODEL_CALLS / AI_MAX_TOOL_CALLS / AI_TIMEOUT_MS / AI_MAX_CONCURRENT / AI_RUNS_PER_MINUTE / AI_MAX_RUNS_PER_HOUR` で範囲内設定が可能。再試行も新規実行として数える。同一requestIdの再送は既存結果を返すだけで課金呼び出しを増やさない。
- 各モデル呼出しの入力は全履歴・system・tool定義・設定を含むUTF-8 JSONで初期65536bytes。`AI_MAX_INPUT_BYTES`で制限し、毎回送信前に検査する。`AI_MAX_OUTPUT_TOKENS`は初期4096を公式SDKへ渡す。bytesは正確なtoken数ではなく、料金保証とは扱わない。
- セッションは最大200、非利用1時間で破棄。セッションごとに実行を100件まで保持し、ID重複検査を維持する。ランダム32バイトのBearerトークンをハッシュ化して照合する。アクセス秘密は一定時間比較する。自己申告IPを信用しない。
- ストアと制限はインスタンス内メモリのみ。再起動でセッション・承認・カウンターは失われ、複数インスタンス間で共有されない。これはサービス全体の課金上限ではない。公開有効化前にCloud Runの認証・最大インスタンス・外部予算/制限等を別途検討する。無認証の有料エンドポイントを公開しない。
- 設計はブラウザ内へ保存する。サーバーのセッションはクラウド保存ではない。AIに画像本体を送る機能は実装していない。
- モデルは宣言済みの6ツール以外を使えない。Goal006で追加した解釈提案も既存ループ内で数える。ファイル・シェル・HTTP・コード実行は提供しない。固定条件はサーバーの設計スナップショットから検査し、モデルがロックを上書きする引数は受け付けない。
- 承認はセッション・requestId・元版・元ハッシュ・ランダム提案IDに結び付く。採用時にもサーバーの元設計から再生成・再検査する。手動変更と新規依頼は古い承認を失効させる。
- 認証失敗、429、タイムアウト、拒否、不正出力、上限、中断を区別する。生のSDKエラーや秘密をレスポンスに出さない。候補にfailが残ればモデルの成功宣言を採用しない。unknownは実物未検証として維持する。

## 検証

`npx vitest run apps/server/test` はネットワーク未使用。テスト内だけでプロバイダーを注入でき、productionでの注入を拒否する。SDKアダプターも公式メソッドの呼び出し引数を通信モックで確認する。実通信の成功・実物確認・公開をこの結果から主張しない。

## Goal 002: 希望と作者の条件を設計へ残す

2026-10-03に上記の公式function calling資料とSDK Models/Part仕様を再確認し、既存SDK・Content履歴・呼び出しID・thoughtSignature・実行上限の方式を維持した。実APIは呼んでいない。

サーバーが実行開始時に `interpretDesignRequest` で依頼文を解釈する。「絵のサイズはそのまま」は現在の幅・高さと画像配置倍率を保護し、「2枚まで」は型紙枚数の上限とする。「紙を増やさない」は現在実際に配置した型紙枚数と既存の上限の小さい方を使う。説明書の枚数は含めない。「もっと大きく」は現在の移動量から増やし、作品の拡大・縮小や速度変更では代用しない。

この解釈は決定的な限定語彙の補助であり、自由な日本語すべての意味を理解するものではない。Goal002時点では否定・矛盾を呼出し前のHTTP 422で返していた。Goal006では、その限定語彙をAIの受付上限にせず、下記の構造化解釈と訂正へ進める。明確な非対応機構だけはモデル呼出し前の `unsupported_motion` を維持する。

元の依頼と設計条件はrun内部のスナップショットに保存する。解釈案と本人の訂正はそれらと照合し、解釈自体を権限として扱わない。モデルが `intent` や `locks` をツール引数に渡しても拒否する。候補生成・最終候補確認・採用の3か所で同じ `applyIntentPatch` を使用する。自然語から追加した固定条件は候補の `input.locks` と `maxSheets` に入り、利用者が採用したときだけ現在のDesignDocumentへ保存される。却下では元の値・固定条件を保つ。既存の固定条件は文章だけで解除できない。固定中の紙上限は利用者が明示的に厳しくする操作だけ許可し、緩和しない。固定されていない上限の緩和にも、Goal006の具体的な差分確認が必要になる。

公開する追加フィールド:

- `run.intentSummary`: `{protections:string[], notes:string[]}`。内部の生のintentは返さない。
- `run.validationIssues`: 最新の実候補のfail検査。部品ID・理由・変更案・検査範囲・設計ハッシュはコアが生成したものを返す。
- `proposal.addedLocks / protectedConditions`: 採用時に追加される固定条件と、その候補が守る条件。
- `proposal.requestedTravelMm / fulfillsRequested`: 明示された距離に届かない代案を見分ける。たとえば希望70mmに対して候補26mmなら、差を示して利用者の採用を待つ。

最初の候補が有効なら、そのまま採用待ちへ進む。幾何failが実際に出た場合は、実検査結果をモデルへ返し、許可された値の再提案または条件変更案へ進む。希望に対応する実候補を作らずに文章だけで成功宣言した場合は成功としない。候補がfailのままなら部品ごとの理由を返し、現設計を保つ。

`intent-loop.test.ts` は本番と同じHTTP・RunManager・コアツール・承認・出力を通す。通信だけを模擬し、模擬プロバイダーも実ツールの検査結果を読んで次の値を選ぶ。8/12/20mmからの相対変更、最初から有効な候補、自然に発生する70mm候補の幾何failからの修正、保護条件の改変拒否、却下と採用、型紙・手順の更新を確認する。静的な成功結果を本番へ追加していない。

開発者作成サンプルによるS4/S5の模擬検証資料は `artifacts/goal002/mock/` に出力する。`evidence.json` は模擬・実API0回・実物未確認を明記する。PDF/SVGは同じ画像データと採用済み設計版を使い、`proposal-run.json` は認可トークン・アクセスコード・APIキー・内部思考を含まない。

追加のUIレビューでは、キャンセルしたセッション作成の遅延応答が次の実行のセッションを上書きする競合を再現し、世代・元設計の照合をref代入前へ移して修正した。`tests/e2e/ai.spec.ts` に旧応答を遅延させる回帰を追加し、最新ビルドに対するAI画面16件（desktop/mobile各8件）が通過した。ログは `artifacts/goal002/e2e-ai-final.log`。これは先に実行した全体42件に対する追加2件を含むAI画面の再検査であり、44件の全体再実行を意味しない。HTTPはテスト内の模擬応答のみで、実Gemini通信はない。

## Goal 003: 背景補正と既存の承認境界

背景用画像は既存の `/api/images` と同じ検証・寸法・容量・同時実行制限を使う。DesignDocumentには画像の識別情報だけを含め、画像本体はGeminiへ送らない。coreの `applyArtworkRepair` は作者の操作用で、AIの `DesignPatchSchema` には追加していない。

模擬通信の回帰で、v2設計の背景補正が通常の候補・承認でも保持されること、モデルによる補正変更が不正引数として拒否されること、手動の補正採用後には旧提案が失効することを確認する。旧Goalの証拠を保持するため、このGoalから同テストの再生成資料は `artifacts/goal003/server-regression/` へ出力する。

## Goal 004: 共通設定・実SDK境界・使用量

`loadServerEnv`と`readConfig`をサーバー、doctor、限定smokeで共用する。未指定時はcwdの`.env`、明示時は`UGOKU_ENV_FILE`だけを読み、既存process環境を優先する。doctorの成功は設定検査のみで、Googleの認証・残高の確認ではない。

GeminiProviderはDeveloper APIの公式URL・v1beta・`vertexai:false`を明示し、別のSDK環境変数で送信先や認証が変わらない。既存の完全なContent履歴・ID・thoughtSignature保持は維持する。公式SDK実体のfetchをテスト内だけで捕捉して、送信URL、ヘッダー、JSON Schema、署名、出力上限、429で内部再試行しないことを確認した。これは実API検証ではない。

`config.test.ts`は一時ファイルと合成キーで共通読込を確認し、doctor子プロセスのfetch/http/netを遮断して、設定済みでも課金通信がなく秘密を出さないことを検査する。以降のコアtoolloop模擬資料の生成先は`artifacts/goal004/server-regression/`で、Geminiの証拠と混同しない。

## Goal 006: 解釈案と作者の権限を分ける

既存の `models.generateContent` とfunction callingを維持する。`propose_request_interpretation` は距離操作（絶対値・単位付き増減量・定性的増減・維持・未指定）、希望方向・禁止方向、絵の大きさ、紙、機構、未解釈の条件を提案する。JSON Schemaは共通のZodスキーマから生成する。単位換算と相対量の計算はコアが固定した元版から行う。明確な定型依頼は初期解釈から候補を作れるため、解釈専用の追加モデル呼出しを必須にはしない。

`run.requestInterpretation` に `binding / interpretation / clarifications / summary / approvalRequired` を返す。構造が正しいだけで意味が正しいとせず、元の依頼・現在の固定条件と照合する。未解決の重要条件があれば `clarification_required` と訂正用の選択肢を返し、候補を採用可能にしない。解釈を変更した場合、以前の解釈で計算した候補は捨てて再計算する。

訂正は同じ開始APIへ、新しい `requestId` と `correction: {runId, requestId, changes}` を送る。外側は新しい依頼ID、内側は訂正対象の実行と依頼ID。`changes.binding` は `{designId, baseRevision, baseHash, requestHash}` で、原文を勝手にtrimせず照合する。訂正した距離・方向等をサーバーで再解釈・検査し、表示だけを書き換えない。訂正元は同一セッションの承認待ちまたは解釈確認待ちの実行に限る。中断・失敗・完了後、設計版・依頼・セッションが違う訂正を拒否し、以前の候補の承認を再利用しない。

既存の固定条件、選択領域、直線1機構、用紙上限はモデルの権限ではない。紙の上限緩和は具体的な変更前後を確認した作者の `paperApproval: {from,to}` が必要で、モデルのスキーマに承認フィールドはない。固定中の条件をこの操作で解除することもできない。候補への承認は引き続き別であり、訂正時点では確定作品を変更しない。

解釈提案はツール回数に、解釈を求めるモデル呼出しは同じモデル回数・時間・入力容量に含める。訂正による新規実行も既存の回数制限に数える。画像本体の送信、別のAPI基盤、追加のライブ試験枠は導入しない。[generateContentの関数宣言](https://ai.google.dev/api/generate-content#FunctionDeclaration) と [署名を元のPartに保持する仕様](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) を2026-10-04に再確認した。実モデル接続は未実施で、SDK通信を捕捉する検査と区別する。
