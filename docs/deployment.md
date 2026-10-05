# ローカル起動とCloud Run準備

## 権限の境界

現在は別の明示承認で[Goal011公開版](public-operation-011.md)を稼働しています。手動制作は一般公開、AIはコード必須、Cloud Run東京＋Vertex＋非公開GCS台帳です。合格版を12月1日または管理停止条件まで維持します。Goal008向けの下記手順・削除済み状態は当時の履歴であり、公開中のGoal011を削除する指示ではありません。

2026-10-05 JST、本人の明示許可に基づく非公開の限定試験と片付けを実施した。Cloud Build・Registry・Secret・専用IAM・Cloud Runを使用し、試験サービスと専用リソースは削除済み。審査用の公開URLはなく、一般公開・継続運用・YouTube投稿・提出は今回の許可に含めない。初回AIの時間切れと中断不具合が見つかり、公開運用にはまだ進めない。[限定試験記録](cloud-trial-008.md)に実測、修正した版、再試験の未実施、費用とsoft delete残存を記録した。以下は再利用可能な準備手順であり、新たな実行許可ではない。

## コンテナ

```sh
docker build -t ugoku-kami-studio:local .
docker run --rm -p 8080:8080 --name ugoku-kami-studio ugoku-kami-studio:local
curl --fail http://127.0.0.1:8080/api/health
```

UIとAPIは同一オリジン。コンテナは非rootユーザー、`0.0.0.0:$PORT`、既定8080。コンテナのファイルシステムに利用者のプロジェクトを永続保存しない。WSLにはDockerがないため、標準GitHub Linuxランナーで検証した。[初回の実行結果](https://github.com/catlover-bot/ugoku-kami-studio/actions/runs/37168807826)では、既存Dockerfileのビルド・実起動・healthに加え、PCと狭幅のChromiumで手動編集・保存復帰・同版の原寸PDF取得が成功した。実コンテナのAI無効状態と実行拒否も確認した。この初回CIはレジストリへのpushやCloud Run実行を含まない。後の限定試験では両イメージをビルド・格納し、非公開Cloud Runで実行後に削除した。

両DockerfileのNodeベースは `node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa` に固定した。これはmultiarch indexではなく **linux/amd64専用のOCI image manifest**。2026-10-04の匿名照合では公式Docker Hubのindexと該当manifestだけを取得し、各HTTP本文のSHA-256、レスポンスdigest、index内のplatform・サイズ・media typeを確認した。[照合記録](../deployment/node-base-image.json)と[Registry公式仕様](https://docs.docker.com/reference/api/registry/latest/)を参照。その後、この固定を使うappとモデルイメージのCloud Build・Cloud Run実起動を限定試験で確認した。arm64等への移植性や公開性能まで検証したものではない。

コンテナ起動後の画面検証は `npx playwright test --config playwright.container.config.ts`。既定の接続先は `http://127.0.0.1:8080` で、この設定はホスト側Webサーバーを代わりに起動しない。証拠には対象コミット・コンテナimage ID・設計版・PDF hashを残す。

対象projectを指定して設定・課金関連付け・API・権限を変更せずに調べる手順は [Cloud候補の読み取り確認](cloud-inspection.md)。認証がない場合は本人の認証まで中止し、既定のhelperは通信しない。

## デプロイ計画（実行しない）

```sh
GCP_PROJECT=your-project GCP_REGION=asia-northeast1 \
CLOUD_RUN_SERVICE=ugoku-kami-studio \
CONTAINER_IMAGE=your-existing-registry/image@sha256:your-digest \
npm run deploy:plan
```

スクリプトは既定・常時dry-runで、gcloudの起動やネットワーク接続を行わない。`--execute`は拒否する。対象プロジェクト・リージョン・イメージの不足を表示する。既存の認証、サービスアカウント、レジストリ、Secret Manager、アクセス制御は運用者が確認する。

実行許可後は、対象と費用上限を確定し、既存リソースを確認、コンテナをビルド・検査、承認したイメージを既存レジストリへ格納、認証必須でデプロイ、許可したアカウントからヘルス/UI/ダウンロードを確認する。IAM変更は必要な対象について別途明示許可を得る。計画は `--no-allow-unauthenticated` と `AI_PROVIDER=none` を初期設定にする。

## Vertex比較候補（未デプロイ）

[Goal009](goals/009-vertex-comparison.md)では、Cloud Run東京のWeb/APIのみ1 vCPU / 1 GiBからVertex AIへ接続する構成を準備しています。モデル重みとOllamaをCloud Runへ同梱せず、`AI_PROVIDER=vertex`、`VERTEX_PROJECT`、`VERTEX_LOCATION=global`、`VERTEX_MODEL=gemini-3.8-flash`を明示し、実行サービスアカウントのADCを使います。APIキーを使うDeveloper APIとは別経路です。Vertexのglobalはモデル処理の東京限定を意味しません。

```sh
npm run deploy:plan -- --vertex
```

これは**オフラインの計画表示・manifest生成だけ**です。認証情報を読み込まず、推論・クラウド書込み・デプロイを行いません。設定不足を表示し、同一projectの実行サービスアカウント、東京のimage digest、固定secret versionを検査します。`--execute`は拒否します。出力だけではIAM保護・全試験の呼出し枠・費用停止・片付けを実施したことになりません。実装と模擬検証はありますが、この構成の実認証・実推論・デプロイ・公開は未実施です。前回試験の許可は流用しません。[比較・料金・承認範囲と終了手順](vertex-comparison-009.md)を参照してください。

## 同一インスタンス内のGemma構成（限定試験後、未公開）

`npm run deploy:plan -- --ollama` は、Cloud Runのapp＋Ollama構成をネットワークなしで検査・表示する。既定の手動版計画と同じく実行機能はなく、`--execute`を拒否する。対象が不足している間はmanifestを作らない。設定がそろった場合の `--output DIR` は、上書きを拒否してローカルへ `service.json`（YAMLとしても有効なJSON）と `plan.json` を出力する。

| 項目 | 初期案 |
| --- | --- |
| Web/API | 1 vCPU / 1 GiB、外部ingressは8080のみ |
| Ollama | 4 vCPU / 8 GiB、0.33.3 CPUランタイム |
| モデル | gemma4:e2b-it-qat / Q4_0、digest `07ea59a474013479c8b6b802bef095c40e964a1d776ba02f264c0e30e1aede0c` |
| 内部通信 | appから同一instanceの127.0.0.1:11434へ。利用者のWSLへは接続しない |
| CPU・スケール | instance-based billing、CPU throttlingなし、startup boostなし、min0、service/revision max1 |
| 同時処理 | HTTP8、アプリAI1、Ollama並列1・待ち行列1・ロード済みモデル1 |
| AI上限 | 6呼出し / 12ツール / 180秒、入力65536bytes / 出力768tokens、16k context、明示json-actions |
| 頻度 | instance内毎分3 / 毎時20。再起動で消え、金額上限ではない |
| 起動 | model/runtime全SHAを再検査、Ollama TCP startup成功後app開始。pull・生成・事前ロードはしない |

HTTPの202応答後もRunManagerが推論を続けるため、短いpollの間だけCPUを与える設定は採用しない。[Cloud RunのCPU割当て](https://docs.cloud.google.com/run/docs/configuring/billing-settings)を使用する。appだけがingressを持ち、11434は共有ネットワーク内でstartup probeを受ける。Ollamaの汎用APIを外へ公開するポート・転送経路は作らない。[複数コンテナの通信](https://docs.cloud.google.com/run/docs/deploying#sidecars)と[startup依存関係](https://docs.cloud.google.com/run/docs/configuring/services/containers#container-startup-order)に基づく。

この5 vCPU / 9 GiBは限定試験の構成で、公開性能・最小構成の保証ではない。既存WSLの16k実L1で観測したOllama＋子プロセスRSS最大は約4.965 GiB（500ms採取、共有ページの重複計上・短いピークの見逃しあり）。Cloud Runの60秒採取ではOllamaの最大観測値は約4.90 GiBだったが、瞬間ピークではない。初回はモデル読込みと約5.7k tokensの前処理が重く、180秒で時間切れ。同一依頼のキャッシュが温まった次の試行は78.5秒で候補提示に到達した。別の希望や新規インスタンスで同じ速さを保証しない。最初のAI操作でモデルを読むため、TCP health成功をAI準備完了と呼ばない。

service-level max1に加えrevision max1を設定し、新revisionへ100%のトラフィックを送り、不要なタグや分割は使わない。[最大instance数](https://docs.cloud.google.com/run/docs/configuring/max-instances)には一時的な超過等の注意点があり、session affinityも永続化ではない。再起動・scale-to-zero・切替でセッション、未採用案、実行制限のカウンターは失われる。ブラウザのIndexedDB作品を残し、再接続後に本人が明示して再実行する。自動的な二重推論をしない。WSL originの保存作品は公開originへ自動移行しないため、必要な作品はファイルで持ち込む。

### 既存ファイルからモデルイメージを準備する

`deployment/ollama/bundle-lock.json` は既存CPUランタイムの各ファイル／symlinkとモデルmanifest・参照blobのSHAを固定する。Gitには重みを入れない。OllamaのMIT表示、同梱ランタイムの第三者ライセンス、モデルmanifestが参照するApache-2.0ライセンスblobも保存する。stageスクリプトは許可リストだけを新しい専用contextへコピーし、再検査する。他のモデル、認証ファイル、`.env`、個人画像をコピーしない。

```sh
node scripts/stage-ollama.mjs --runtime "$OLLAMA_RUNTIME_DIR" \
  --models "$OLLAMA_MODELS_DIR" --out artifacts/goal008/model-context
```

`OLLAMA_RUNTIME_DIR` は既存0.33.3の `bin/ollama` と `lib/ollama` があるディレクトリ、`OLLAMA_MODELS_DIR` は既存 `manifests/`・`blobs/` の親を明示する。実stageではmodel 4,336,359,085 bytes＋runtime 70,751,265 bytesの全SHA一致を確認した。これはイメージの圧縮サイズではない。Dockerがある検証環境で、次にビルド・起動を確認する（このWSLでは未実施）。ベースイメージ取得はモデル取得とは別である。

```sh
docker build --platform linux/amd64 -t ugoku-kami-app:review .
docker build --platform linux/amd64 --network none -t ugoku-kami-ollama:review artifacts/goal008/model-context
```

通常CIのモデルなしappコンテナ確認は維持する。4GBの重みを通常CIで新規取得しない。モデル入りイメージは限定試験のCloud Buildで作り、同一Cloud Runインスタンス内の2コンテナを実ブラウザから確認した。検証・権限設定を中間build stageで済ませ、完成したbundleを最終imageへ一度だけCOPYし、chmodによる重みの重複レイヤーを避ける。試験したappとOllama双方のレジストリdigestは非公開の試験記録に保持した。タグだけの画像指定は計画生成が拒否する。コンテナは非root、重みは読み取り専用であり、起動時にdownloadしない。

### 対象と許可がそろってから行う操作

計画生成へ渡す設定は `GCP_PROJECT`、`GCP_REGION`、`CLOUD_RUN_SERVICE`、`CONTAINER_IMAGE`、`OLLAMA_CONTAINER_IMAGE`、`CLOUD_RUN_SERVICE_ACCOUNT`、`AI_ACCESS_SECRET_NAME`、数字の固定version `AI_ACCESS_SECRET_VERSION`。画像は選択projectのArtifact Registryの `@sha256:` 参照に限る。計画はsecretの値やGeminiキーを読まず、Secret Manager参照だけを出力する。参照secretは32文字以上のAIアクセスコードとし、runtime service accountへそのsecret限定の読取りを与える操作も、承認対象に含める。公開アクセスを希望するときだけ `CLOUD_RUN_PUBLIC=true` も記録するが、計画スクリプトはIAMを変更せず、現状の公開／非公開も保証しない。

```sh
npm run deploy:plan -- --ollama --output artifacts/goal008/reviewed-deployment
```

対象・費用・期間・公開範囲の承認とコンテナ検証が済んだ運用者が、承認したイメージだけをregistryへpushし、生成したmanifestをレビューして `gcloud run services replace artifacts/goal008/reviewed-deployment/service.json --project "$GCP_PROJECT" --region "$GCP_REGION"` を実行する。これは実在するgcloud操作の手順であり、`deploy:plan`の実行機能ではない。適用後は実際のrevision、image digest、CPU設定、秘密参照、IAM、trafficを読取り確認する。

審査用サイトを誰でも開ける構成は別途許可されたIAM設定で実現し、AI実行だけを既存アクセスコードで制限する。サイト全体を本人だけが読めるIAM設定のまま審査可能と呼ばない。審査コードはGitや公開画像・動画へ載せない。実URLはサービス応答から取得し、推測で作らない。

公開判定には、新規ブラウザで実Gemma→実検査→比較→本人採用→同版PDF/ガイド→保存再開をPCと狭幅で実行し、不成立・中断・session失効時の原本保持、冷間／温間時間も記録する。別端末からの確認は実施した場合だけ記録する。health、stage、YAML形状検査、既存WSL実行だけでは公開AI合格にならない。検証失敗時は公開URLを提出しない。停止・費用・12月1日までの保全は承認した運用計画に従い、公開撤回とinstance停止を別操作として確認する。

公式参照は2026-10-04確認。Cloud Runの[コンテナ契約](https://docs.cloud.google.com/run/docs/container-contract)、[health check](https://docs.cloud.google.com/run/docs/configuring/healthchecks)に基づく構成は限定試験でadmission・実起動まで確認した。Goal008試験時点の公開判定は不合格で、Gemma経路の中断修正後Cloud再試験は未実施。[実測と片付け](cloud-trial-008.md)を過去の準備状態より優先して参照する。

## 有料AIを有効化する前に

- 明示された利用許可の対象・呼び出し上限・期間を確認する。キーの存在だけを許可扱いしない。
- Developer APIは`AI_PROVIDER=gemini`と`GEMINI_API_KEY`・`GEMINI_MODEL`、Vertexは`AI_PROVIDER=vertex`と上記3つの`VERTEX_`設定・ADCを使う。両方とも32文字以上の`AI_ACCESS_SECRET`を別に必要とする。`VITE_`変数に秘密を入れない。
- APIキー・ADCはGoogleへのサーバー側認証、AI_ACCESS_SECRETはアプリへのアクセス用。ブラウザにはGoogleキーや認可トークンを渡さない。アクセスシークレットはUIで入力し、保存しない。
- 公開環境ではTLS・Cloud Runの認証境界・適切な共有方法を整える。アプリのアクセスコード等はSecret Managerから注入する。VertexのADCは付与した実行サービスアカウントを使い、ソースやコンテナにキーを埋めない。
- 上限の既定は1実行6モデル呼び出し/12ツール/90秒。同時実行1、インスタンス内毎分6/毎時60。リトライもモデル呼び出しに数える。
- これはインスタンス内制限であり、課金総額の保証ではない。再起動でカウンターは消える。複数インスタンスや再デプロイを含むサービス全体の認証・クォータ・費用監視を確認する。
- セッションはメモリのみ。再起動後は新セッションで再実行する。複数インスタンスへの分散は未対応。ブラウザに保存した作業は独立して残る。

## Developer APIの限定ライブ確認

以下は既存のDeveloper API用手順で、Vertexの試験手順・上限・許可とは別です。Vertexは[比較試験計画](vertex-comparison-009.md)を参照してください。許可がない通常実行は必ずスキップする。

```sh
npm run smoke:live
```

課金なしの設定・計画確認は `npm run doctor` と `npm run smoke:live -- --plan`。設定場所と既存キーの方式は[AI接続の設定手順](live-gemini.md)、料金根拠は[比較・試験計画](vertex-comparison-009.md)を参照する。

許可を得た運用者だけが、接続設定とビルドを用意し、まずL1を1件実行する。1件最大6モデル呼び出し・12コアツール・90秒・各回入力65536bytes/出力4096tokens。限定確認全体は失敗・再試行を含め3件、18モデル・36ツール・AI処理270秒で、開始前に永続台帳へ枠を予約する。

```sh
npm run build
LIVE_API_AUTHORIZED=yes npm run smoke:live -- --case L1 --authorize-paid-api
```

これは専用localhostで通常のFastifyサーバー、実SDK、ブラウザUIの候補採用とPDF出力をつなぐスクリプト。L2/L3はL1の採用・PDF確認後に個別指定する。呼出し許可は起動時の環境変数とCLIフラグの両方が必要で、`.env`へ許可を残す方式ではない。模擬プロバイダーのテスト成功は実API成功ではない。中断後に新たなリクエストを開始しないが、送信済みリクエストの課金取消しは保証しない。
