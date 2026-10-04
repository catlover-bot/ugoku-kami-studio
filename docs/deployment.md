# ローカル起動とCloud Run準備

## 権限の境界

本作業はGCPプロジェクト作成、課金有効化、API実行、リソース作成、IAM変更、公開デプロイを許可されていない。以下は準備手順。現時点では公開URLはない。

## コンテナ

```sh
docker build -t ugoku-kami-studio:local .
docker run --rm -p 8080:8080 --name ugoku-kami-studio ugoku-kami-studio:local
curl --fail http://127.0.0.1:8080/api/health
```

UIとAPIは同一オリジン。コンテナは非rootユーザー、`0.0.0.0:$PORT`、既定8080。コンテナのファイルシステムに利用者のプロジェクトを永続保存しない。ローカル検証環境にはDockerがないため、Dockerビルド・実起動は未実施。CIにビルド・ヘルスチェックを用意しているが、CI実行成功も別途確認が必要。

## デプロイ計画（実行しない）

```sh
GCP_PROJECT=your-project GCP_REGION=asia-northeast1 \
CLOUD_RUN_SERVICE=ugoku-kami-studio \
CONTAINER_IMAGE=your-existing-registry/image@sha256:your-digest \
npm run deploy:plan
```

スクリプトは既定・常時dry-runで、gcloudの起動やネットワーク接続を行わない。`--execute`は拒否する。対象プロジェクト・リージョン・イメージの不足を表示する。既存の認証、サービスアカウント、レジストリ、Secret Manager、アクセス制御は運用者が確認する。

実行許可後は、対象と費用上限を確定し、既存リソースを確認、コンテナをビルド・検査、承認したイメージを既存レジストリへ格納、認証必須でデプロイ、許可したアカウントからヘルス/UI/ダウンロードを確認する。IAM変更は必要な対象について別途明示許可を得る。計画は `--no-allow-unauthenticated` と `AI_ENABLED=false` を初期設定にする。

## 有料AIを有効化する前に

- 明示された利用許可の対象・呼び出し上限・期間を確認する。キーの存在だけを許可扱いしない。
- `AI_ENABLED=true`、`GEMINI_API_KEY`、`GEMINI_MODEL`、32文字以上の `AI_ACCESS_SECRET` をサーバー環境へ設定する。`VITE_`変数に秘密を入れない。
- APIキーはGoogle用、AI_ACCESS_SECRETはアプリへのアクセス用。利用者のブラウザにはAPIキーを渡さない。アクセスシークレットはUIで入力し、保存しない。
- 公開環境ではTLS・Cloud Runの認証境界・適切な共有方法を整える。Secret Managerから注入する。ソースやコンテナにキーを埋めない。
- 上限の既定は1実行6モデル呼び出し/12ツール/90秒。同時実行2、インスタンス内毎分6/毎時60。リトライもモデル呼び出しに数える。
- これはインスタンス内制限であり、課金総額の保証ではない。再起動でカウンターは消える。複数インスタンスや再デプロイを含むサービス全体の認証・クォータ・費用監視を確認する。
- セッションはメモリのみ。再起動後は新セッションで再実行する。複数インスタンスへの分散は未対応。ブラウザに保存した作業は独立して残る。

## 限定ライブ確認

許可がない通常実行は必ずスキップする。

```sh
npm run smoke:live
```

課金なしの設定・計画確認は `npm run doctor` と `npm run smoke:live -- --plan`。設定場所、既存キーの方式、公式モデル・料金根拠は [実Geminiの設定手順](live-gemini.md) を参照する。

許可を得た運用者だけが、接続設定とビルドを用意し、まずL1を1件実行する。1件最大6モデル呼び出し・12コアツール・90秒・各回入力65536bytes/出力4096tokens。限定確認全体は失敗・再試行を含め3件、18モデル・36ツール・AI処理270秒で、開始前に永続台帳へ枠を予約する。

```sh
npm run build
LIVE_API_AUTHORIZED=yes npm run smoke:live -- --case L1 --authorize-paid-api
```

これは専用localhostで通常のFastifyサーバー、実SDK、ブラウザUIの候補採用とPDF出力をつなぐスクリプト。L2/L3はL1の採用・PDF確認後に個別指定する。呼出し許可は起動時の環境変数とCLIフラグの両方が必要で、`.env`へ許可を残す方式ではない。模擬プロバイダーのテスト成功は実API成功ではない。中断後に新たなリクエストを開始しないが、送信済みリクエストの課金取消しは保証しない。
