# Goal010-R — 審査用公開の運用差分案

2026-10-05確認。**計画のみ。公開・継続費用は未承認で、以下の永続制御も未実装です。** [非公開試験](vertex-trial-010.md)の削除済みURLは審査用URLにしません。既に確定した専用project・請求先を維持し、追加のアカウント確認や変更は求めません。

| 項目 | 公開案と必要な差分 |
| --- | --- |
| 到達方法 | 東京の専用Cloud Run 1サービスをHTTPS公開。審査員はブラウザだけで利用し、CLI・Googleログイン・本人のGoogleキーは不要。一般利用は手動制作／画像入力／PDF／ブラウザ内保存、AIだけ既存のアクセスコードを審査向け手順で別配布。コードを公開ページ・動画へ埋め込まない。[公開設定](https://docs.cloud.google.com/run/docs/authenticating/public) |
| 構成 | Web/API 1 vCPU・1 GiB、instance billing（非同期実行中もCPUを割当）、min0、service/revisionともmax1、HTTP concurrency8、モデル同時実行1。既存Vertex `gemini-3.8-flash` / `global` / LOW、ADC runtime SAを維持。Gemma常駐・GPU・独自domain/LB・別モデルは追加しない。 |
| 試験依存の解消 | 現状は運用者PCのproxyがGoogle ID tokenを付け、ローカル台帳から署名permitを発行する。直接URL公開だけでは動かない。さらに現行permit署名はAIアクセスコードと同じ秘密なので、審査員へコードを渡した状態で署名権限を信頼できない。**permit検査の無効化では解決しない。** 同じAPI内へ予約処理を移し、署名鍵を利用コードから分離するか、信頼された内部permitとして扱う。 |
| 永続化と再起動 | 現在のsession・重複判定・開始制限・provider予算はRAM、永続試験台帳は運用者PC。候補は専用非公開GCSの小さな単一状態objectへ、request/base版・call ID・予約・精算をgeneration条件付き更新で保存し、送信前に確定させる方法。競合・保存失敗は送信しない。再起動後の重複を拒否し、送信有無不明の予約を残す。作品画像や認証値は台帳へ保存しない。実装・障害試験が必要。[GCS条件付き更新](https://docs.cloud.google.com/storage/docs/request-preconditions) |
| セッション失効 | 再起動・切替でRAM上のrun／候補は失効し得る。ブラウザの確定作品と入力を保持し、自動再送せず本人の再操作へ戻す。既存の失効復帰を利用する。max1／session affinityは永続性や二重送信防止の代わりにならず、max設定を一時超過する場合もある。[実行環境](https://docs.cloud.google.com/run/docs/container-contract)・[max設定](https://docs.cloud.google.com/run/docs/configuring/max-instances) |

実装確認箇所: [app.ts](../apps/server/src/app.ts)、[runs.ts](../apps/server/src/runs.ts)、[trial-permit.ts](../apps/server/src/trial-permit.ts)、[vertex-budget.ts](../apps/server/src/vertex-budget.ts)、[trial-ledger.ts](../scripts/trial-ledger.ts)。既存の版・作者保護・採用再検査、usage観測、失敗／中断時の予約保持を引き継ぐ。将来の公開枠を非公開試験の固定ID・$3.90設定へ混ぜず、旧試験台帳も維持する。

**利用量と費用（USD、クレジット・無料枠控除0）**。10/5から12/1末までの保守的な58日で計算し、実際の開始時に短縮する。1利用＝AI2依頼、1依頼平均3送信、1送信の総token平均6,000という計画値。総tokenを全量高い出力単価$7.50/Mで見積もる。公式Standardの通常単価は入力$1.50/M・出力／thinking $7.50/M。年内表示$0.75/$3.75は50% credits backの注記があるため差し引かない。平均値は送信上限や実請求ではない。[Vertex料金](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

| 58日間の仮定 | AI依頼／モデル送信 | モデル計画額 | Run計画額 | その他予備を含む計画額 |
| --- | ---: | ---: | ---: | ---: |
| 通常: 5利用/日 | 580／1,740 | $78.30 | $6.96 | **$88.26**（その他$3） |
| 集中: 20利用/日を全期間 | 2,320／6,960 | $313.20 | $27.84 | **$346.04**（その他$5）。下記枠では受け付けない |
| 参考: 1台が全期間常時稼働 | AIとは独立 | 別計上 | **$100.224** | Runだけの金額。上限保証ではない |

RunはCPU $0.000018/秒＋RAM $0.000002/秒＝**$0.072/時**。1利用に起動60秒＋AI 2×90秒＋操作60秒＋アイドル900秒＝20分を見込む。Gemma構成の料金は流用しない。min0でも停止は即時ではなく、アクセス継続で長期稼働し得る。[Run料金](https://cloud.google.com/run/pricing)・[アイドル／スケール](https://docs.cloud.google.com/run/docs/about-instance-autoscaling)

その他の通常予備$3には、[Build](https://cloud.google.com/build/pricing)累計60分×$0.006＝$0.36、[Registry](https://cloud.google.com/artifact-registry/pricing)総1 GiB保管約$0.19、[Secret](https://cloud.google.com/secret-manager/pricing)2 active版の保管約$0.23＋access、[Logging](https://cloud.google.com/products/observability/pricing)2 MiB/利用＝0.5664 GiB×$0.50＝約$0.28、外向き15 MiB/利用＝4.248 GiBの転送費、および小さいソース／台帳の[Storage保管・操作](https://cloud.google.com/storage/pricing)と削除後保持分を含める。転送先・実容量で変動する予備で、個別SKUの実請求は別途確認する。ログには本文・画像・秘密を残さず、イメージ保持総量と旧版削除を管理する。

**管理枠案: 今回までの通算$5とは別に、公開期間へ追加$100（モデル$85、インフラ$10、安全余裕$5）。** AIは全利用者合計10依頼/日・30モデル送信/日、全期間600依頼・1,800送信、同時1、開始2/分・4/時。各依頼6モデル／4ツール／90秒／入力32,768 bytes／出力設定2,048 tokensを維持する。失敗・中断も開始を消費し、自動再試行なし。各受付前に6回分を予約し、各送信前にも残枠を検査。内訳不足は総量による上方見積もり、総量も不明なら従来の送信済み不明予約を保持する。$0.556032/送信の既存予約も厳密な課金上限の証明ではない。日次の実使用量／保持予約とインフラ推計を照合し、先に達した回数・金額・期限で停止する。未実装の運用制御案であり、請求の自動遮断や期間中の無停止を保証しない。[通知予算の限界](https://docs.cloud.google.com/billing/docs/how-to/budgets)

**資源・停止・承認。** 必要なのは専用Run公開権限、Vertex predict権限のruntime SA、専用Build SA／Registry／非公開source・台帳bucket、利用コードと必要なら署名鍵のSecret、既存Logging/Monitoring。APIを無関係に追加せず、権限は当該資源へ限定する。AI停止フラグを各送信前に確認し、枠不足では手動を維持、インフラ枠超過・期限には専用serviceを非公開化／削除する。送信済み計算の停止は保証しない。終了時は専用イメージ・秘密・ソースを片付け、監査台帳を非公開保全し、[soft delete既定7日](https://docs.cloud.google.com/storage/docs/soft-delete)やログ／履歴の残存を費用0・即時消去としない。

最終確認は一括で、**対象: 確定済み専用projectに上記の公開運用差分／公開範囲: 手動は一般公開・AIは審査用コード限定／期間: 公開開始から2026-12-01 23:59 JSTまたは管理枠到達まで／追加予算: 控除前$100**。現在はこの公開承認、永続予約と停止機能の実装・再起動／競合回帰、公開経路の実確認が未完了で、審査用URLを「準備済み」とは扱わない。
