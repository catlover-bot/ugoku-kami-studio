# Goal009 — Vertex AI比較候補と次の限定試験

2026-10-05確認。ローカルGemma/Ollamaを維持し、提出候補として **Cloud RunのWeb/API＋Vertex AI Gemini** を準備した。Vertexの実認証・実推論・デプロイは未実施。前回のGemma限定試験は終了済みで、その許可を今回へ流用しない。公開URL・YouTube公開・Zenn提出も未実施。

## 構成を比較する

| 項目 | 既存Gemma | Vertex提出候補 |
| --- | --- | --- |
| 推論 | ローカルOllamaを継続。前回Cloudはモデル同梱のCPU sidecar | Gemini `gemini-3.8-flash`、Standard PayGo、`global` |
| Cloud Run東京の割当 | 前回app 1 CPU / 1 GiB＋モデル4 CPU / 8 GiB | appのみ1 CPU / 1 GiB、モデル重みの格納なし |
| 認証・接続 | 既存ローカルloopback | ADC、Cloud Runに専用SAを付与。APIキーを使わない |
| 費用 | モデルAPI料金なし。Cloud利用時のCPU・保管等は有料 | モデル使用量＋Cloud Run等。クーポン対象は個別確認が必要 |
| 現在の証拠 | [前回Cloud実測](cloud-trial-008.md)：初回180秒timeout、同一依頼の温状態78.514秒 | SDK実装・模擬通信済み。実際の速度・使用量・割当は未確認 |
| 共通部分 | 設計コア、固定条件、検査、本人採用、ブラウザー保存、同版PDF | 同じコアと制作画面を再利用 |

Vertexのモデルは一つに固定する。公式表ではGA、function calling対応、Standard PayGoはglobal/us/eu。今回はglobalを選び、Cloud Runの東京配置と区別する。**モデルの処理が東京に限定される構成ではない**。LOW thinkingを指定し、非対応のMINIMALとcandidateCountを送らない。[モデル仕様](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash)、[3.8ガイド](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash)

Vertex adapterは `AI_PROVIDER=vertex`、`VERTEX_PROJECT`、`VERTEX_LOCATION=global`、`VERTEX_MODEL=gemini-3.8-flash` の明示設定を必要とする。Developer API用の `gemini` 経路とは別で、接続失敗時の自動切替はない。ADC認証ファイルやSA秘密鍵を新規発行して配布しない。Cloud Runでは実行SAのADCを使う。実行SAの候補権限は `aiplatform.endpoints.predict` と `serviceusage.services.use` の専用role、および試験用secretに限るaccessor。IAMはproject範囲であり、一モデルへの制限はアプリ設定で行う。[推論の権限](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/access-control)

CPU常時割当、min0・service/revision max1、HTTP同時8・AI同時1とする。既存の非同期実行・poll中にCPUを止めないためで、待機中にも割当分の費用がかかり得る。min0は即時停止の保証ではない。session affinityはメモリ上のsession・候補を永続化しない。再起動時も原本をブラウザー保存から再開できるようにする。

## クーポンと確認の境界

大会特典の発行通知を確認した。発行は、請求先への登録・適用成功の証拠ではない。公式案内は有料アカウントへの切替を適用条件に含み、登録締切2026-10-20、登録後2か月の有効期間を示す。一部サービス除外があるため、Vertex Geminiへ使えるとはまだ判断しない。[大会の参加特典](https://zenn.dev/hackathons/google-cloud-japan-ai-hackathon-vol5)

指定のprojectと請求先の関連付け、請求先open=true・JPYを読み取り確認した。これらは現在の無料トライアル／有料の証拠ではない。Billing APIの管理情報はクレジット行の残額・終了日・対象SKUも返さないため、本人画面で次だけを確認待ちとする。[BillingAccountの公開項目](https://docs.cloud.google.com/billing/docs/reference/rest/v1/billingAccounts)

- 現在の請求先種別。
- 大会特典の適用先請求先ID、残額・通貨、終了日、対象・除外サービス（Vertex Geminiを含む）。未登録・表示なしもそのまま記録する。

過去に確認したログイン一致・project用途は確認を繰り返さない。初回無料トライアルの以前の表示残額・期限は履歴として保全し、大会特典と合算しない。現在の請求先が有料なら、対象外または残額・期限超過分は自己負担になり得る。古い無料トライアル条件を今回の費用0の根拠にしない。登録・アップグレード・請求先変更は実行していない。

## ローカルで完了した改善

- モデルに渡す派生描画座標とpass定型文の重複を省いた。原本、固定条件、依頼原文、fail/unknownの理由・範囲は保持する。前回初回入力の再構成では **24,671→19,560 bytes（20.7%減）**。これはオフラインの入力サイズ比較で、Cloud応答時間・token削減の実測ではない。
- 全ツール処理が成功し、希望どおりの候補が決定的検査を通った場合だけ、要約のための追加推論を省く。曖昧さ・不成立・未解決エラー・代案は通常ループへ残す。自動採用はせず、同じ最終検査と本人承認を通す。
- Google GenAI SDK 2.27.0の実際の通信変換を模擬HTTP/OAuthで検証。Vertex v1・global・明示project・ADC Bearer、APIキー混入防止、署名とtool ID保持、403/429/500・出力上限・中断と遅延応答・承認前の原本保持を確認した。実Google認証・推論は0回。
- 中央の作品、一か所の希望入力、同じ候補比較領域を維持。接続先は管理設定で分け、通常画面にモデル切替を増やしていない。設定済み表示・模擬実行・実行記録を分けた。前回の本文なしDELETE修正も維持した。

## 限定試験の上限案

「1件」は通常UIから開始するAI依頼1回。失敗・中断・再試行も1件として数える。1件の内部で最大2回のモデル呼出しを許す。SDK再試行は1 attemptに固定し、4成功を得るまで繰り返す運用にはしない。

| 制限 | 1件 | 全試験 |
| --- | ---: | ---: |
| AI依頼 | 1 | 最大4件 |
| モデル呼出し | 最大2回 | 最大8回 |
| ローカルツール | 最大4回 | 最大16回 |
| 入力 | 各モデル呼出し32,768 UTF-8 bytes | 最大262,144 bytes |
| 設定する出力 | 各モデル呼出し2,048 tokens | 最大16,384設定tokens |
| AI待機時間 | 最大90秒 | 計360秒 |
| Cloud Run | 1 CPU / 1 GiB、設定max1、AI同時1 | 最大30分 |
| Cloud Build | e2-standard-2 | 累計最大20分 |
| 保存 | app image最大1 GiB、source最大50 MiB、secret 1 version | 終了時削除、作成から24時間以内 |

入力はシステム指示・全履歴・ツール定義・署名を含むSDK request表現のUTF-8サイズで測る。HTTPの全転送量や正確なtoken数ではない。出力2,048は送信する `maxOutputTokens` である。**Vertex 3.8のthinkingまで合算した請求上限との対応は一次資料で未確認**のため、この表をthinking課金の厳密な上限と呼ばない。LOW thinkingとし、下記では別途予備費を予約する。取消済みの送信・時間切れの未取得usageも費用0にしない。

アプリの時間当たり4件制限だけでは、再起動をまたぐ総4件を保証しない。試験実行時はローカルの永続ledgerに**送信前**に枠を記録し、失敗・再試行を含め4枠までとする。追加AIや範囲外モデルは開始しない。入力・出力設定を増やさず、2回で候補に至らない場合も試験結果として残す。

| 順 | 通常UIでの操作 | 確認する結果 |
| --- | --- | --- |
| 1 初回 | 新規session、サンプル20mmから25mmを依頼 | 初回AI時間、検査、比較・採用、同版PDFとガイド、保存再読込 |
| 2 別依頼 | 起動後、新しい依頼文・目標で実行 | 同一prompt cacheだけに依存しない応答、候補の希望一致、同版PDF |
| 3 不成立条件 | 原本を保存し、用紙・寸法条件を守ると成立しない希望 | 決定的fail/条件変更提案を確認。成立扱い・無断条件解除・原本上書きなし |
| 4 中断後の復帰 | AI開始後に中断し、手動編集・保存・再読込・PDF | DELETE成功、サーバー中断、後続呼出し停止、遅延候補を不採用、原本保持 |

4件目の「復帰」は手動制作へ戻れること。中断後に5件目の実AIを再実行する試験は含めない。再依頼の操作自体は模擬検証で確認する。実物に印刷して工作が動くことはPDF取得と別で、今回も未検証のままとする。

サービス作成→Ready、コンテナ起動、最初のhealth、初回AI、起動後の別依頼、採用→PDFを別々に測定する。各モデルcallの時間・input bytes・prompt/output/thinking/cache/total tokens・未取得usage、モデルversion、元と採用のhash、PDF metadata/hash、メモリ、失敗・中断を記録する。前回Cloudの同一依頼78.514秒、WSLの値、今回の別依頼は測定条件が異なり、同条件ベンチマークとして倍率比較しない。

## 標準料金換算の管理見積もり

モデルは入力$1.50・出力$7.50 / 100万tokensを使用する。2026年末までの表示価格はnet spendの50%クレジット還元を伴うため、適用未確認の還元を先引きしない。出力料金にはresponseとreasoningを含む。[公式価格](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

| 項目・見積もりの仮定 | USD |
| --- | ---: |
| モデル入力：8×32,768 tokensを予約（入力1 byteを1 tokenとみなす計画仮定） | 0.393216 |
| 設定出力：8×2,048 tokens | 0.122880 |
| thinking未確認分の追加予約：8×65,536 tokens | 3.932160 |
| Cloud Run 1 CPU/1 GiB・30分、起動・推論・待機を含む | 0.036000 |
| Cloud Build 20分 | 0.120000 |
| Registry 1 GiB×24時間 | 0.003288 |
| Secret 1 version×24時間＋1,000 accessesの予備 | 0.004973 |
| 外向き転送0.2 GiB・ログ0.05 GiBの予備 | 0.049000 |
| source 50 MiB、7日soft delete・操作等の予備 | 0.100000 |
| **クレジット控除前・予約を含む計画合計** | **4.761516（切上げ約4.77）** |

thinking予約はモデルの公称最大出力65,536を各callに追加して置いた**見積もり上の予備**であり、確認できたthinking専用上限ではない。inputのbyte→token換算も正式なtokenizer保証ではない。使用量が仮定を超える／usageが不明で次回分を安全に予約できない場合は停止する。実際の利用・課金明細は試験後に分けて報告する。

Cloud Runのinstance料金をCPU $0.000018/s＋メモリ $0.000002/GiB-s、Build $0.006/min、Registry $0.10/GiB-monthとして計算。転送・ログ・sourceは未実測の予約額。無料枠の残量、割引、税、JPY換算を確定費用として加減しない。[Cloud Run](https://cloud.google.com/run/pricing)、[Cloud Build](https://cloud.google.com/build/pricing)、[Registry](https://cloud.google.com/artifact-registry/pricing)、[Secret Manager](https://cloud.google.com/secret-manager/pricing)、[Storage](https://cloud.google.com/storage/pricing)

現時点のクーポン控除額は0として計画する。適用先・残額・期限・対象がそろった分だけ、後から「標準費用」「クレジット充当」「自己負担」に分ける。全サービスを有効なcreditが十分カバーする場合に限り、その範囲の自己負担0を見込める。これは旧試験$1.39とは別の新試験費用で、12月1日までの継続運用費を含まない。

5ドルは課金の遮断額ではない。instance上限も設定値として記録し、1instance分の見積もりを請求の保証上限と扱わない。次の依頼予約＋経過時間から計算した費用が目安を超える、4件・8call・30分・Build20分に達する見込みの場合、次の処理を開始しない。既送信のcancelが課金取消しを保証しないため、usage欠測時も予約を残す。30分枠には起動・UI確認・削除時間も含め、余裕を残して停止する。

## 実行前の承認範囲と終了手順

個別対象の一覧はGit対象外の `artifacts/submission/private/goal009/comparison-plan.md` にまとめた。coupon確認後に、必要なAPI有効化、専用runtime/build SAと最小IAM、app imageビルド・格納、小容量source・secret、IAM認証付きCloud Run、上記4件の実推論、証拠保存・削除を**一括の具体的な範囲として**提示する。いまは実行未承認で、承認前に書込みはしない。

終了時は新規依頼停止→in-flight中断→ログ・採用設計・PDFのローカル保全→Cloud Run削除→build停止→今回のimage・source・secret削除→不要な専用IAM/SA/role撤去→一覧による再確認とする。事前に既存名との衝突を確認し、既存資産の上書き・削除はしない。APIとGoogle管理agent・履歴を共有物と区別し、残るものを記録する。soft deleteに残るsourceの費用要因も記録する。期限は初回作成から24時間以内で、成功しても長期運用しない。

無料トライアル・割当・IAM等の制限時は具体的なエラーを記録して停止する。アップグレード、GPU、外部の別API、割当増加、allUsers/allAuthenticatedUsers公開へ進まない。試験URLは停止後に提出用として使えない。

オフライン計画は `npm run deploy:plan -- --vertex` で確認できる。認証・外部通信を行わず、不足設定を表示する。設定を渡す場合も同一projectのSA・Tokyoのimage digest・secret versionを要求し、`--execute` は拒否する。この出力だけでは4件の永続制限・費用停止・IAM設定・片付けは実施されない。

提出素材のVertex構成図と紹介文は非公開の「公開候補・未デプロイ」案として用意した。既存のWSL収録MP4と4画像をVertex成功の証拠へ読み替えていない。最終的なmain/CI証拠は [検証記録](verification.md) と非公開 `main-integration.json` へ記録する。
