# Goal010 — 使用量の観測と通算予算の継続試験

前回結果は[Goal009](vertex-trial-009.md)、今回の承認範囲は[Goal010](goals/010-metering-and-final-trial.md)。前回費用も含む5米ドルで、中断・中断後の別依頼・不成立条件の残り3件を確認する。クレジット控除は0。有料請求先の追加クーポンの期限・適用範囲は未確認のままとし、試験開始条件にはしない。

## 原記録と予約の突合

前回の配信SHA `4f43b25b54e2ae02dddc24f3fa35049a0b8e677d`、アップロードtar、ビルドprovenance、配信digest、保存したrun、SDK2.27.0とそのlock integrityを照合した。アプリとSDKは2回送信し、残る4枠は未送信と判断できる。SDKのattempts=1は初回を含み、再試行0。宣言したfunction toolsのみでSDKの自動ツールループはなく、runは第2応答から終了しサービスも削除済み。この判断は提供者内部の課金監査ではない。

旧台帳は変更しない。新しいハッシュ連鎖JSONL台帳の初期イベントに原台帳と証拠のSHA-256、算定方法、変更前後を保存する。

| 区分 | 米ドル |
|---|---:|
| 前回の6枠予約 | 3.336192 |
| 送信済み2回、不明のため保持 | 1.112064 |
| 根拠を確認した未送信4枠の解放 | 2.224128 |
| 前回インフラ推計・予備（全額引継ぎ） | 0.171668569 |
| 新規インフラ枠 | 0.700000000 |
| 安全予備 | 0.228331431 |

モデル資金枠3.9ドルと上記のインフラ・安全予備を合わせて5ドル。中断1、復帰3、不成立最低1の計5枠がすべて不明でも、旧分を含む管理額は4.992224ドルとなる。これは実費でも確定上限でもない。新規インフラの残り全稼働時間・保存・操作・転送等の計画額は0.641623ドル以下で、0.7ドル枠に含める。新しい応答で安全な推計ができれば、不成立依頼へ最大6枠まで配分可能。18回すべての不明予約が入るとは仮定しない。

## 欠測を消さない記録

以前の生usageMetadataは保存されていないため、前回2回の欠測原因は未特定。Monitoring集計を個別応答へ代入しない。新実装はHTTP応答とSDK応答の両方で、本文の変換前に許可した数値、存在区分、responseId、attemptId、call、SDK・モデル版、finishReasonを記録する。欠落・null・明示0・不正を区別し、中断や後続変換失敗でも観測を保持する。入力文・画像・内部思考・認証・署名を診断項目に加えない。

- `usage-estimate`: 必要な内訳と整合する総量による見積もり。
- `aggregate-upper-estimate`: 内訳不足でも矛盾しない総量を最高出力単価で評価した上方見積もり。
- `sent-unknown`: 観測不足・矛盾がある送信の予約を維持。
- `reserved-not-sent`: 未送信枠。真正な終了証拠が得られた場合のみ解放。
- `billing-actual`: 実際の請求明細。上記のいずれも明細ではない。

[REST仕様](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/GenerateContentResponse#UsageMetadata)と[SDK定義](https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponseUsageMetadata.html)で、totalはprompt・candidate・tool・thinkingを含み、cacheはpromptに含まれる。重複加算しない。表示用の6項目が欠けていれば内訳完備にはしないが、費用の算定可否とは分ける。

[公式料金](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)のglobal Standardは2026年末まで50% credits backの表示。還元を差し引かず、既存計画の入力1.50／出力・思考7.50ドル毎100万tokenを保守的単価として維持する。入力bytesと出力設定2048、思考予約65536から算出した1枠0.556032ドルは予約の仮定であり、正確なtokenizerや厳密な請求遮断を意味しない。

## 送信と終了の境界

本人IAM認証のloopback接続で、ローカル台帳へcall UUIDの予約と転送開始をfsyncしてからCloud Runへ送信する。試験専用署名permitをsession・request・設計版・配信SHAに結び付け、サーバーは各SDK HTTP送信直前に残額と一意IDを検査する。SDKの2回目のHTTP試行も拒否する。外側と内側の予約は同じ支出であり二重に足さない。新しいDBやサービスアカウント鍵は作らない。

転送後クラッシュ・応答喪失・不完全な終了記録では可能性のある枠を保持する。署名permitだけで台帳を再初期化しない。ハッシュ破損・途中行・fsync失敗・生きたwriter lockは新規処理を止める。二重精算は同一証拠のみ冪等で、矛盾する精算で残額を復活させない。

中断応答はアプリの後続送信ループが閉じた後に返す。キャンセル前の状態も記録し、先に正常完了した試行を実行中の中断成功に数えない。提供者側の計算・請求停止は保証しない。

## 検証・成果物

ローカルの実SDK合成応答、クラッシュ・再起動・二重精算、UI中断待ち回帰を先に実施する。実APIは残る3依頼の中でだけ使用量も観測する。Cloud Run東京1CPU/1GiB・min0/max1・AI同時1、Vertex `gemini-3.8-flash`/global/LOW、32768bytes・2048tokens・90秒・tool4を維持する。前回稼働339.978秒、ビルド128.385秒を引き継ぐ。新稼働残6860.022秒、新ビルド残3471.615秒。

非公開の根拠・台帳・試験結果・PDF・削除確認は `artifacts/submission/private/goal010/`。新試験の実測は終了後追記する。一般公開URL、YouTube URL、Zenn最終提出、100%印刷と50mm線・実組立・動作確認は別途未完了。試験URLは削除し、提出用URLへ流用しない。
