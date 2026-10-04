# Cloud候補の読み取り確認

この手順は、利用者が指定して読み取りを許可した **1つのproject / region** だけを調べる。公開・課金・API有効化・IAM変更の許可を兼ねない。実在するproject ID、請求先、照会結果は公開ソースへ記入せず、`artifacts/submission/private/` に保持する。

## 既定は通信しない

```sh
node scripts/inspect-cloud.ts --project YOUR_PROJECT_ID --region asia-northeast1
```

既定では計画だけを表示し、CLIもネットワークも呼ばない。環境変数や既存設定からprojectを推測しない。`--execute`や未知の引数は拒否する。実行時も使用するCLIと設定ディレクトリを絶対パスで指定する。

## CLIと本人の認証

CLIは[公式配布](https://docs.cloud.google.com/sdk/docs/install-sdk)の対象アーカイブと同じ掲載SHA-256を照合してから、専用のユーザー領域へ展開する。版付きURLと最新版URLのアーカイブは同一versionでもbyte列が異なる場合があるため、掲載チェックサムの対象URLと照合する。`install.sh`・`gcloud init`・sudo・shell profile編集は不要。展開した `bin/gcloud version --format=json` で実versionを確認する。CLI取得はモデルの取得やCloudリソース作成とは別である。

確認済みのローカル構成例は以下。実際の導入パス・version・配布SHAは非公開の `gcloud-installation.json` に記録する。

```sh
UGOKU_GCLOUD="$HOME/.local/opt/ugoku-kami-google-cloud-cli-587.0.0/google-cloud-sdk/bin/gcloud"
UGOKU_GCLOUD_CONFIG="$HOME/.local/share/ugoku-kami/gcloud-config"
```

認証がなければhelperは `authentication_required` で止まり、project APIへ送信しない。必要な場合は**利用者本人が自分のターミナルで**次の認証操作を行う。helperはログインを起動せず、service account鍵の作成・取得、ADCの作成、他作品の認証流用もしない。

```sh
# 本人が明示して行う操作。自動実行しない。
CLOUDSDK_CONFIG="$UGOKU_GCLOUD_CONFIG" \
CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true \
"$UGOKU_GCLOUD" auth login --no-launch-browser --project YOUR_PROJECT_ID
```

ブラウザの本人認証を完了し、OAuth URL・認証コード・トークンをチャット、Git、ログへ貼らない。`gcloud init`やproject一覧取得は使わない。指定config内のactive accountが1つの場合だけhelperがその既存認証を使う。認証したことをデプロイ等の許可と扱わない。

## 明示的な読み取り実行

```sh
node scripts/inspect-cloud.ts \
  --project YOUR_PROJECT_ID --region asia-northeast1 \
  --gcloud "$UGOKU_GCLOUD" --config-dir "$UGOKU_GCLOUD_CONFIG" \
  --output artifacts/submission/private/cloud-inspection.json \
  --execute-read-only
```

出力ファイルは新規作成のみ、0600。非公開ディレクトリは0700。既存結果の上書きやsymlink経由の出力は拒否する。標準出力は状態・照会数のみで、account、請求先、token、生のエラーメッセージを出さない。実行結果にproject IDやbilling account名があるため、このJSONをそのまま公開しない。

gcloudがAPI有効化を提案・実行する経路を避けるため、gcloudはlocal version・active認証確認・既存access token取得だけに使用する。tokenはメモリ内に捕捉し、以下の固定REST読み取りへ渡す。redirectを拒否し、各要求30秒・応答2MB・一覧最大5pageに制限する。失敗を自動再試行しない。

| 確認 | 読み取り先 | 結果の意味 |
| --- | --- | --- |
| project | Resource Manager `projects/{id}` GET | 指定ID・project number・状態。別ID応答なら中止 |
| 課金 | Cloud Billing `projects/{id}/billingInfo` GET | 課金関連付けと有効状態。クーポン残額・期限・支払手段は確認しない |
| API | Service Usage `projects/{number}/services` GET、ENABLEDのみ | 既存API。無効なAPIは有効化しない |
| Cloud Run | `projects/{id}/locations/{region}/services` GET | 名前・URL・資源設定等の限定要約。container env・secret値は結果に含めない |
| quota | Cloud Quotas `.../services/run.googleapis.com/quotaInfos` GET | regionの適用範囲を残す。API無効/権限なしは不明。CPU/メモリ合計5/9のadmissionを保証しない |
| 権限 | Resource Manager `projects/{id}:testIamPermissions` POST | 本人のproject-level権限照会のみ。IAM付与・policy変更ではない |

一覧の `complete:false`、`api_disabled`、`permission_denied` 等を「なし」や「適合」に読み替えない。project-level権限があっても、個別service accountのactAs、secret/repository権限、条件付きIAM、組織policy、地域の空き容量は別確認。helper成功はコンテナ起動、Cloud Run適合、予算承認、公開可能の証拠ではない。未確認項目を残したまま `deploy:plan` のdry-run境界を越えない。

2026-10-04公式確認: [CLI認証](https://docs.cloud.google.com/sdk/gcloud/reference/auth/login)、[project権限照会](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/testIamPermissions)、[Cloud Quotas API](https://docs.cloud.google.com/docs/quotas/reference/rest/v1/projects.locations.services.quotaInfos/list)、[Cloud Run quotas](https://docs.cloud.google.com/run/quotas)。通常CIは注入fixtureだけでhelperを試験し、Cloudへ接続しない。
