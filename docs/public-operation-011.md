# Goal011 公開版の実装と運用

Goal011は本人の一括承認に基づく追加100米ドル枠です。旧試験5ドルと送信済み不明予約は別に保全します。クレジット・無料枠は控除しません。公開URLと実Vertexの結果は公開前検証後に追記します。現時点ではコード・模擬回帰を実装した段階です。

Web/APIは東京のCloud Run 1 CPU・1 GiB、instance billing、min0/max1、HTTP concurrency8。既存Vertex `gemini-3.8-flash` / `global` / LOW / ADCを維持します。制作画面を定期アクセスして温存しません。ローカルGemmaとの自動切替はありません。

審査用コードはAI受付の認証だけです。外部trial permitは拒否し、サーバー内部の能力オブジェクトを発行します。GCS非公開objectへgeneration CASで6送信分を先に予約し、実HTTP前に1枠をpossibly-sentへ確定します。usageが整合すれば精算、欠測・矛盾は予約を保持します。終了時は未送信枠だけ解放し、90秒leaseが切れた旧プロセスの追加送信を拒否します。台帳の欠落時には自動再作成しません。[GCS条件付き更新](https://docs.cloud.google.com/storage/docs/request-preconditions)

全利用者合計10依頼・30送信/JST日、600依頼・1,800送信/期間、開始2/分・4/時・同時1。1依頼6モデル/4ツール/90秒/32,768bytes/出力2,048tokens。公開前6依頼/24送信も同じ期間台帳に算入します。重複requestと同じ作品・版・依頼の指紋を保持し、再起動やID変更で再送しません。作品・希望本文・認証値は台帳へ保存しません。台帳は600件・2MiB・直近64操作の応答確認記録に制限します。

モデル枠85ドル。入力$1.50/M、出力・thinking $7.50/Mを使い、年内50% credits backを控除しません。送信前予約は$0.556032、1依頼$3.336192。入力bytesと出力設定・thinking余裕による管理予約で、厳密な請求上限ではありません。[Vertex料金](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

インフラ枠10ドル・安全余裕5ドル。別のCloud Run Jobが3時間ごとにCPU/RAM割当秒・全network種別の送信bytes・HTTP件数をMonitoringから読み、公開開始からの累計を保守的に推計します。CPUは$0.000018/秒、RAMは$0.000002/GiB秒。転送は全bytesを$0.25/GiB、ログは1要求8KiBを$0.50/GiBとして計画します。実転送先・SKU・請求反映とは区別します。[Run料金](https://cloud.google.com/run/pricing)・[割当と転送の監視指標](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z)

固定インフラ予約$1.50にBuild累計60分（$0.36）、1GiB以下のRegistry保存、Secret1版、Scheduler2job、GCS保管・操作、通知設定と削除後の小規模監査保管を含めます。監視Jobの各60秒最低課金を別に累積し、次の3時間＋監視遅延5分の最大1台稼働も予約します。推計$6で警告、$8でサービス全体を停止し、残り$2と別枠$5に余裕を残します。全期間常時稼働ならRunだけで約$100となるため、12月1日までの無停止は保証しません。

停止Jobは制作サービスを起動せず、独立したサービスアカウントで監視します。監視や台帳に障害がある場合も専用サービスの削除へ進みます。2026年12月1日23:59 JSTには別のSchedulerが直接サービスDELETEを呼び、アプリ自身と台帳も期限後の実行を拒否します。日次点検・警告の通知と、実際の削除処理は別です。通知は厳密な課金遮断ではありません。[予算通知の制約](https://docs.cloud.google.com/billing/docs/how-to/budgets)

削除は今回のサービス・Registry・Secret・ソースobject・Scheduler2件だけです。非公開の台帳・監視結果、小さなJob定義・IAMと監査ログは保全します。サービス・Registry・Secretの削除権限は対象リソースのIAMに限定します。SchedulerはJob単位のIAMを提供しないため、削除1権限を専用projectへ期限付きで付与し、コードで固定した2件だけを削除します。このprojectへ他用途のSchedulerを追加しないでください。

検証: 保存Cの応答列を再構成したfixtureは、70mm/45mmの違反を保持し、35mmを希望未達の代案として提示・採用・同版PDFへ進みます。新しい実Vertexの成果とは区別します。実物は未検証です。通常のローカル回帰と公開前の実台帳・実HTTPS結果は、最終の検証記録に保存します。
