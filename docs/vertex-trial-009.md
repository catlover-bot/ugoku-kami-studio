# Goal009 — 非公開Vertex試験の結果

2026-10-05 JST。今回の一括承認による新しい限定試験として、Cloud Run東京のWeb/APIからVertex AI `gemini-3.8-flash`（global、LOW thinking）を呼び出した。**最初の1依頼で候補生成・検査・比較・採用・同版PDF・保存再開が成功した。試験サービスは削除済み。** 一般公開・継続運用・YouTube公開・Zenn提出は行っていない。

残りの別依頼・不成立・中断は実施していない。使用量が完全な記録として取得できず、予約額を保持すると次の依頼分が費用管理枠へ収まらないため、新規処理を停止した。4件成功した記録ではない。

## 実行した構成と変更

- 配信コード：`4f43b25b54e2ae02dddc24f3fa35049a0b8e677d`。
- appイメージ：`sha256:5cdb802501f60a693cc46d1e0a69c5e40f1ba263b64a9c94ba9d288ead8bc14b`、111,615,461 bytes。
- Cloud Run：`asia-northeast1`、1 CPU / 1 GiB、CPU常時割当、min0 / service・revision max1、AI同時1、IAM invoker検査有効。
- Vertex：`gemini-3.8-flash` / `global`、専用実行SAのADC。Developer APIキー、GPU、Gemmaの自動切替は使用していない。モデル処理の東京所在は保証しない。
- 必要APIのうち未有効だった `aiplatform.googleapis.com` を有効化。専用runtime/build SA、prediction/useのみのcustom role、repository、約2 MBのsource bucket、secret 1 versionを作成した。SA秘密鍵は発行していない。
- runtimeには `aiplatform.endpoints.predict` と `serviceusage.services.use`、試験secretだけのaccessorを付与。buildには試験repository writer、source reader、log writer、service useを付与した。Owner/Editorは付与していない。
- 本人のIAM認証を127.0.0.1限定の接続経由で使用。未認証healthは403、本人認証healthは200。公開メンバーなし。project・請求先の関連付け、別環境・既存APIキーは変更していない。

個別project・請求先・試験URL・Cloud revision・全変更の記録はGit対象外の `artifacts/submission/private/vertex-trial-20261005/` に保管した。削除した試験URLは提出用URLには使えない。

## 実測と通常UIの結果

| 確認 | 結果 |
| --- | --- |
| コンテナ初回起動 | Monitoringのstartup latency 5.059秒。ログのinstance開始→probe成功は5.158秒 |
| 作成要求→Ready観測 | 27.935秒。ポーリングの観測間隔を含む |
| 最初の認証付きhealth | 13.255秒。WSLからの接続・本人token取得を含み、純粋なcontainer起動時間とは別 |
| 続く認証付きhealth | 34.982 ms。起動後のAI応答時間ではない |
| 最初のAI依頼 | UI送信→終端受信6.305秒、server run 5.727秒 |
| モデル呼出し | 2回、各2.112 / 3.581秒、tool 1回。入力14,463 / 17,170 UTF-8 bytes |
| 作者の条件 | 20→25 mm、画像の大きさと紙枚数を保持。採用前の原本を維持し、決定的検査後に同じ位置・縮尺で比較して採用 |
| 検査 | 寸法・ガイド・可動範囲・紙面・枚数・固定条件はpass。実物動作はunknownのまま |
| PDF・ガイド・保存 | 採用した第2版のA4全5ページを取得。PDF metadataの版/hash、ガイド第4工程、保存・再読込の版/hashが一致 |
| メモリ | appの返却されたサンプル最大83.305 MiB。瞬間ピークやVertex側モデルのメモリではない |
| インスタンス | Monitoringで同時最大1を観測。再起動や長期運用を検証した結果ではない |
| 別依頼・不成立・中断 | 費用予約の停止条件により未実施。既存の模擬試験を実Vertex成功へ読み替えない |

初回AIと別依頼の比較は未完了。前回Gemmaの180秒timeout・同一依頼78.514秒と入力・処理条件が異なり、同条件での速度倍率は主張しない。紙への印刷・組立・実物動作も未検証。

採用設計は `goal009-comparison-fish` 第2版、hash `ed80b7cb9983144f2a6f7d3160d14b8aba6f97433fcc447dc6ef5c3c405c3298`。成果物ディレクトリは `artifacts/submission/private/vertex-trial-20261005/browser-initial-2026-10-05T07-53-29.867Z/`。

- `adopted.pdf`：PDF SHA256 `925930464c0dc1f5db5537e67411776b516a1cdcdc806cc7868f5090b13e98be`。
- `adopted.ugoku.json` と `reloaded.ugoku.json`：採用・再開した同じ設計。
- `case-result.json` / `run-final.json` / `browser-run-record.json`：実応答・操作・版の照合記録。
- 比較、印刷、組立ガイド、狭幅、保存再開の実画面PNGを保全。

## 費用と使用量の限界

現在の請求先は本人確認済みの有料アカウント。追加クレジットの終了日・対象範囲は未確認のまま、本人の新しい指示により試験開始の条件から外した。無料トライアルとの合算はせず、**クレジット・無料枠・割引を一切控除しない**。

| 標準料金換算・予約の内訳 | USD |
| --- | ---: |
| Build実時間128.385秒 | 0.012839 |
| Run作成要求→削除確認339.978秒を1 CPU / 1 GiBで換算 | 0.006800 |
| Registry実測サイズ×repository存在期間 | 0.000005 |
| Secret version保管 | 0.000026 |
| source保管・操作・soft deleteの予備 | 0.100000 |
| 転送・ログ・secret操作の未実測予備 | 0.052000 |
| **インフラ推計と予備の合計** | **0.171669** |
| **Vertexの使用量未確定による予約保持** | **3.336192** |
| **費用管理上の合計** | **3.507861** |

これは**実請求額でも、全額消費した金額でもない**。RunのMonitoring allocation換算は$0.005401だったが、期間全体の大きい見積もりを採用し、二重加算していない。Registryは格納時系列まで確定した請求値ではない。保存・転送等の予備も保証上限ではない。

1依頼の送信前に最大6call分$3.336192を永続台帳へ予約した。完全なusageだけで精算する設計で、今回2callとも必要な使用量の完全性を確認できず、全予約を維持した。次の予約を加えるとモデルpool $3.90を超えるため、残り3件を開始しなかった。5ドルは課金の強制遮断額ではない。

Monitoringでは同model/globalのinput 6,772・output 243 tokensを取得したが、thinking内訳、outputへのthinking包含、各call/requestとの完全な対応を確認できない。完全usageや請求明細としては扱わない。必要fieldが欠けたのか、不整合だったのかは今回の保存記録から特定できない。部分数値と欠測理由を残す修正を追加し、欠測を0補完しない検証を行った。この修正は今回配信したSHAの後であり、Cloudで再試験していない。

試験projectのBigQuery dataset一覧はHTTP200・0件・ページ残りなし。既存の請求exportは確認できず、SQLや新規exportは実行していない。**利用明細・実クレジット消費・円建て自己負担は未取得**であり、「明細を取得したが未反映」とも「請求0」とも断定しない。

単価の根拠：[Vertex公式価格](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)、[Cloud Run](https://cloud.google.com/run/pricing)、[Cloud Build](https://cloud.google.com/build/pricing)、[Artifact Registry](https://cloud.google.com/artifact-registry/pricing)、[Secret Manager](https://cloud.google.com/secret-manager/pricing)。モデルinput $1.50 / output+thinking $7.50 per millionを使用し、50%クレジット還元表示も控除しない。

## 片付けと残る課題

2026-10-05 16:57:58 JSTにservice削除確認、16:58:10 JSTに全片付け終了。作成から24時間以内、Run2時間・Build60分の承認上限内。サービス・repository・bucket・secretは一覧0件。試験SA2件とcustom roleを削除し、project IAMの追加・削除差分は試験前に対し0、請求先関連付けも一致した。既存SA・既存データは保持した。ローカルの使い捨てaccess codeも削除した。

source 2,016,304 bytesはsoft deleteとして2026-10-12 16:58:01 JSTまで保持予定。予定日時は物理削除済みの証明ではなく、残る保管費用を上の予備に含める。有効化したAPI、既存Google管理agent、Build履歴・ログ、回復可能な削除済みroleは残る。稼働中の試験サービスや専用モデルendpointは残していない。

公開へ進む前に、実usageの欠測理由を確認し、別依頼・不成立・中断後復帰を同じ通常UIで再確認する必要がある。公開時の継続費用・認証・再起動によるsession消失の扱いも別途決める。試験用のプロセス内制限とローカル永続台帳を、そのまま一般公開の全体課金上限として使わない。
