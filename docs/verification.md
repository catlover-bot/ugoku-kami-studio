# 検証記録

## Goal 005 — 入力から中断再開・組立まで（進行中）

2026-10-04。[依頼全文](goals/005-product-experience.md)。開始時のmainは `aaba6c4afe6cd001bf639a164ecc55adbd8397fe`、同SHAの[Check](https://github.com/catlover-bot/ugoku-kami-studio/actions/runs/37169793731)成功と作業ツリーがクリーンであることを確認した。既存サーバー・成果物を保持し、A→B→C→Dのまとまりで通常統合する。Bの保存repositoryとCの印刷分割は別worktreeで準備し、Aには混ぜていない。

Aでは数値を文字列draftとして保持し、Enter/blurで一度確定、Escapeで取消し、無効値を欄の近くに表示する。スライダーと選択枠は終了時に一履歴、キャンセルは開始状態へ戻す。「元に戻す」「やり直す」を分け、新しい編集でRedoを破棄する。履歴は作品内に限定し、Undo/Redoで版を進め、実物記録は保持する。AI・印刷・候補採用の前に入力途中を確認でき、入力開始で古いAI応答を失効させる。

仕様変更に合わせて、旧E2Eと性能計測スクリプトの数値入力を `fill` だけから `fill` + Enterへ更新した。数値欄のroleは入力途中の文字列を許すtextboxへ、旧「やり直し」は「元に戻す」へ変更した。既存の寸法・記録・AI応答保護のassertionは維持している。

Aの作業ツリーで `npm run check`（lint/型検査/単体・統合101件/build）と `npm run test:e2e -- --workers=4`（PC53・モバイルChromium53、106件）が成功。追加P2/P3試験は実UIの空欄・小数・Enter+blurの二重確定防止・無効値・Escape・native text Undo・ドラッグ・pointercancel・held-key・Redo・記録保持・実PDFの版を確認する。IMEは合成compositionイベントの処理確認であり、実OSの日本語入力や実iPhoneの確認とは区別する。各統合のクリーン導入・SHA/CIは `artifacts/goal005/` の実行記録に残す。

変更前の同条件証跡は `artifacts/goal005/before/manifest.json`（自作絵/サンプル×PC/狭幅、36画面、実PDF4件）。実物・実Gemini・初見の人・実スマートフォン・Cloud Run公開は引き続き未実施。B〜DとP1/P4〜P8の新しい受入確認はこの段階では未完了。

## Goal 004-R — 現在の統合方針

2026-10-04。[再開指示の全文](goals/004-resume-and-main.md) により、確認済み変更のコミット、作業ブランチpush、mainへの通常統合・push、必要なPRと通常CIの実行が許可された。以下の過去記録にある「作成者未設定」「push保留」「Goal全体の外部確認待ち」は当時の事実として保持し、今回の停止条件にはしない。実API課金・GCP/IAM変更・Cloud Run公開は引き続き未許可。

GitHubの既存認証を読み取り、login `catlover-bot` / user ID `203637895` / 表示名 `m.hirotaka` が指定本人と一致することを確認した。既存のGit作成者設定が空だったため、このリポジトリだけに確認済み表示名とID付きnoreplyアドレスを設定した。global設定は変更していない。

開始時はHEAD・remote mainとも `c7f1149508e0ef7a31d159f2e64450fceefbd3e0` で、旧Goalブランチにも追加コミットはなかった。最新実装はステージ済み62ファイル・未ステージ31ファイル・未追跡のソースに存在した。差分・開始時hashはローカルの `artifacts/goal004r/baseline.json` に保全し、indexと作業ファイルの両方を公開レビューした。確認済みの103パスを明示して最新版をステージし、同じ内容であることをhashで確認した。元の依頼文のCRLFは保持し、空白検査は `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --cached --check` で実行した。

### 初回統合と今回の実行結果

初回コミットは [`65daa5bbc5a8fa8b57285803a88d8099dabc969b`](https://github.com/catlover-bot/ugoku-kami-studio/commit/65daa5bbc5a8fa8b57285803a88d8099dabc969b)、treeは `65d3acc91eb667f7383f73d3adf64160dd8a84ea`。`feat/004r-main-integration` をpushし、[統合前Check](https://github.com/catlover-bot/ugoku-kami-studio/actions/runs/37168807826)の2ジョブ成功後、クリーンな別worktreeでmainへfast-forwardし通常pushした。[main統合後の同SHAのCheck](https://github.com/catlover-bot/ugoku-kami-studio/actions/runs/37168984383)も2ジョブ成功した。保護ルールがないことを確認し、PRは作成していない。GitHub APIでremote mainのSHA・treeとローカルmain/origin/mainの一致を実確認した。旧ブランチは削除していない。

コミット済みの状態を `/home/mhirotaka/workspace/ugoku-kami-studio-integration-check` に別worktreeとして展開し、元のnode_modules・未追跡ファイル・残存buildを使わず検証した。元の作業場所と開発サーバーは保持した。

| 今回実行したコマンド | 結果 |
| --- | --- |
| `npm ci` / `npm run doctor` | lockfileからの新規導入と設定確認成功 |
| `npm run check` | lint・型検査・単体/統合97件・本番ビルド成功 |
| `npm run test:e2e -- --workers=2` | 92件成功（PC46、狭幅Chromium46） |
| `npm run examples` | 4例成功、幾何pass・物理unknown |
| `npm run smoke:live` | SKIPPED、実API呼出し0 |
| GitHub `container` job | Docker build/run/health成功、PC/mobile手動フロー2件成功 |

clean worktreeのPC・狭幅スクリーンショットも画像表示で確認し、文字欠け・重なり・横方向の切断は見られなかった。これは実スマートフォン・人による利用試験ではない。新規CIのコンテナ検査はサンプル20→18mm編集、ブラウザ保存・reload・同じ版/hashへの復帰、AI無効APIの503拒否、PDF内設計ID/版/hash・全ページA4・ページ数を実コンテナに対して照合する。ホスト側Nodeで行った事前2件はDocker成功とは数えていない。

ローカル証拠は `artifacts/goal004r/` の `clean-verification.json`、`initial-branch-ci.json`、`initial-visual-review.json`、`*-publication-review.json` と `logs/clean-*.log`。Dockerの成果物はCIの `container-verification` artifact（保持7日）。生成物、node_modules、build、依頼の開始時差分、秘密用設定はGitへ含めない。自作画像とOFL同梱の公開フォントだけをソースへ含めた。

### 初回main反映後の保存不具合修正

初回mainを基点に `fix/004r-project-size` を作成した。個別には5MiB以下の合法PNGを12枚含む約50.4MBの作品が、書き出し成功・保存済み表示になった後、自分自身の45MB読込上限で復帰できない問題を再現した。`project.ts` で読込・書込を共通の45,000,000 UTF-8 bytesと同じ保存スキーマで検査し、100件の記録上限も対称にした。`App.tsx` は記録追加・読込時の既存記録統合を反映前に検査し、失敗時は作品・入力中の下書き・未保存表示を保持する。写真を自動削除・圧縮せず、本人が減らして追加し直せる。

追加unit4件でbyte境界、日本語のUTF-8超過をJSON解析前に拒否、100/101記録、12枚の合法PNGによる合算超過を確認した。追加E2E4件（PC/mobile各2）では、超過拒否→下書き4写真を保持→2写真を削除→約42MBで追加・実ファイル出力→reload後そのファイルを再読込する操作が成功した。100件を超える追加・同一作品の101件への統合も、元記録と下書きを失わず拒否する。旧来の上限超過ファイルは引き続き読込不可だが、読込失敗で現在の作品を置き換えない。

この修正の回帰は `tests/unit/project-size.test.ts` と `tests/e2e/project-size.spec.ts`。通常の `check` / `test:e2e` に含まれる。初回統合の97/92件と追加の部分実行は合算して一度の実行結果とはしていない。最新コミットの全体検証は各SHAのGitHub Checkと、ローカル `artifacts/goal004r/` の実行ログ・検証JSONに記録する。

### 外部確認の個別状態

| 区分 | 状態 |
| --- | --- |
| A ローカル実装・自動検証 | 上記のクリーン環境で成功 |
| B コミット・main統合・push | 初回統合済み、remote SHA/tree確認済み |
| C GitHub CI・コンテナ | 初回統合前・main統合後のCheck、実コンテナ検証成功 |
| D 実Gemini | 未実行。キー・アクセスコード・明示実行許可なし |
| E 印刷・組立・実物 | 未実施。手動設計の試作PDFと同版の記録票を保持 |
| F 初見の人・実スマートフォン | 未実施。自動Chromiumの結果と区別 |
| G Cloud Run公開 | 未実施。公開URLなし、dry-run準備のみ |

本人の次の作業は [実Geminiの設定とL1](live-gemini.md)、[試作004の印刷・実測](prototype-004.md)、[人による確認手順](physical-validation.md) を参照。実Gemini・実物の未確認はA〜Cの統合を止める条件にしていない。以下のGoal001〜004は当時の記録として残す。

## Goal 004 — 実Geminiへの設定導線と、印刷する1作品

2026-10-04。**実Gemini未実行、実物未確認**。通常API・画面・採用・PDF経路の予行は模擬通信であり、ライブ成功に加算しない。初見の成人・実スマートフォン・Docker実起動・公開も未実施。課金有効化、IAM変更、クラウド作成はしていない。

開始時にorigin `catlover-bot/ugoku-kami-studio`、ブランチ `feat/003-design-and-usability`、既存index 62ファイルとその後の未ステージ20・未追跡25を実確認した。作業状態を保持したまま `feat/004-live-gemini-and-prototype` を作成。開始時hashと差分は `artifacts/goal004/baseline.json` と `*-at-start.patch` にある。Git作成者情報は未設定で、推測設定・commit・push・PRを行っていない。既存indexのtreeは `2f738cdf43c0fc7db4aa59443a39b656670a9dae`。最新ソースの記録は同フォルダの `source-state.json` を参照。

### 実装した経路と、発見して直した問題

- サーバー・doctor・smokeが同じ `loadServerEnv` / `readConfig` を使う。実装済みDeveloper APIとSDKを継続し、接続先・認証方式・modelを公式資料で照合した。設定場所、優先順位、上限、料金の計算根拠、許可後のコマンドは [実Geminiの設定](live-gemini.md)。doctor/planは秘密の有無だけを表示し、Googleへ問い合わせない。
- SDKの隠れた接続先変更・内部再試行を止め、全履歴のUTF-8 JSON容量と出力上限を送信前に適用。取得したprompt/output/thinkingなどの使用量を各呼出しごとに記録し、未取得を0料金としない。入力byte数を正確なtoken数とは呼ばない。
- `smoke:live` は専用localhostサーバー上の通常画面で候補を比較・採用し、通常PDFワーカーで取得。別SDKの挨拶や固定距離の返答で代替しない。許可は当該起動の環境変数とCLIフラグの両方が必要で、`.env`の許可値だけでは起動しない。L1を最初に1件、後続ケースはその成功後に個別指定する。
- 全試行の台帳は `artifacts/goal004/live/ledger.json`。開始前に最大枠を予約し、失敗・中断も含め最大3試行/18モデル/36ツール/AI処理270秒。各試行は最大6/12/90秒、入力65,536 bytes・出力4,096 tokens/回で、設定が厳しければそちらを使う。並行起動・壊れた台帳・曖昧なCLIケース指定を拒否し、自動再試行しない。未実行の現時点では台帳もAPI呼出しも0件。
- 通常E2Eが起動済みの実AIサーバーを再利用できたため、専用4183ポートでAI無効・秘密なしのサーバーを毎回起動するように修正した。CI/testからのライブコマンドも拒否する。
- 依頼を書き直しても旧依頼の候補が届く問題を修正。古い実行を中断して結果を失効させる。poll通信失敗後は新規実行ではなく同じ実行の「状況を確認する」で再開でき、遅延応答による重複中断も防ぐ。
- AI記録の書き出しに元版・候補版・採用版・差分・検査・実行ID・モデル・取得済み使用量を残す。却下・中断・依頼変更後も直近20実行を保持し、秘密や画像は含めない。通信未確認時は「Gemini設定済み」、テスト注入は「模擬接続（テスト）」と表示する。
- 不正な画像正規化応答でも元作品を保持し、画像選択の近くに選び直しを案内。実物記録には10往復程度の初期チェック、4方向の様子・写真ラベルを追加。旧保存の空欄・3写真を保持して読み込み、未確認の向きを推測しない。

### L1〜L3の実行区分

| ケース | 実Gemini | オフラインで確認したこと |
|---|---|---|
| L1 大きく動かす・絵と紙を維持 | 未実行 | 試験専用モデル通信のみ注入。実サーバーのtools/coreで15→19mmを計算し、採用前の元版保持、採用、元版と採用版のPDF、A4寸法・ページ数・PDF内部の設計ID/版/hash・画面からのAI記録を照合。距離19mmを本番コードへ固定していない |
| L2 両立しない70mm | 未実行 | 同じ試作設計の実際のguides-on-base/slot-contained違反を事前計算。注入モデルはこの本物のfailを受け、幅変更などを提案するだけで保護条件と元版を維持 |
| L3 回転 | 未実行 | 通常UIで非対応を説明し、元版を保持。モデル呼出し前に止まるのでGemini応答の成功とはしない |

PCと狭い画面の予行資料は `artifacts/goal004/rehearsal/{desktop,mobile}/{L1,L2,L3}/`。`mode: injected-test` と実物未確認を明記した。実APIトークン使用量はなし、呼出し0回。試験用のusage値は課金実績ではない。

### 今すぐ印刷する1件

[試作004のPDF・材料・手順](prototype-004.md) は **手動設計** `prototype-004-fish` 第1版、hash `87d67ffa2f65ce6d87ab3799fd1a3eaee1f130aada24321537b7c2fe475f50d5`。白背景の開発者作成画像、台紙160×110mm、右15mm、厚紙0.25mmの仮定、8部品・型紙1枚＋説明4ページ。

`artifacts/goal004/prototype/kit.pdf` は通常UIから得た5ページ。画像込みの `prototype.ugoku.json`、設計と検査、材料、部品別工程、両端の予定画像、未記入の実物票を同じフォルダに保存した。PC1440×1000/390×844で元版と画像を保持して取得し、PC/mobile/coreの全5ページを100dpiのRGBA画素で照合して一致。全ページと画面を目視確認済み。`browser-proof.json`、`visual-review.json`、`construction-audit.json` が証拠で、予定画像を写真とはしていない。

実物の次の操作は、1ページ目を100%で印刷して50mm校正線を測る→指定材料・工程で組み、工程外の修正を部品ID/寸法とともに記録→両端と途中の引っかかり・ガイド保持→10往復程度の初期チェック→正面・裏面・始点・終点の記録。アプリの同版フォームは空欄で、結果を自動登録していない。実Gemini採用版が得られた場合は、そのrunフォルダに同版の `prototype/kit.pdf` と材料・手順を作り、手動版を残す。

### 検証コマンドと残る制限

`npm run check`（lint/typecheck/単体・統合/build）、`npm run test:e2e -- --workers=2`、`npm run examples` を実行。単体・統合97件（12ファイル）、E2E92件（PC46・mobile46）、examples4例が成功。最終終了状態は `artifacts/goal004/logs/check-final.log` / `e2e-final.log` / `examples.log` と `manifest.json` に記録する。部分実行の件数や過去Goalの件数は加算しない。最初のライブ予行はアクセスコードlabelに補助文も含まれることをハーネスが扱えず失敗したが、locatorを修正して全ケースを再検証した。実APIは呼んでいない。

`npm run doctor` / `npm run smoke:live -- --plan` / 既定 `npm run smoke:live` / `npm run deploy:plan` も通信なしで確認。Dockerコマンドが存在せず実起動は未実施。実機スマートフォン、初見の成人、印刷・組立・撮影、公開は未実施。

機構は矩形の可動紙と直線引きタブのみ。模様背景のずれ・枠をまたぐ輪郭・紙厚/接着/摩擦/折り精度は未解決条件のまま。複数の写真付き実物記録を多数蓄積すると既存の45MBインポート上限に達し得る。UI bundle約1.62MBとPDF worker約1.31MBで、低速端末・回線での性能保証はしていない。全体を製品完成・実物動作保証とは総括しない。

## Goal 003 — 紙の編集机と印刷の一致

2026-10-03。開始時の `feat/002-creator-value` / HEAD `c7f1149508e0ef7a31d159f2e64450fceefbd3e0`、ステージ済み62・未ステージ19・未追跡11ファイルを確認した。開始時のファイルhashと状態は `artifacts/goal003/baseline.json`。新ブランチ `feat/003-design-and-usability` に作業状態を維持したまま移り、index tree `2f738cdf43c0fc7db4aa59443a39b656670a9dae` を変更していない。既存のGoal001/002本文・記録・成果物は保持している。

実装前にPC1440×900・狭幅390×844で、サンプル開始→候補比較/採用→保存再開と、自作3画像の入力→数値選択→元画像/両端→PDFを実ブラウザで操作した。観察は5点に絞り、再現・影響・証拠を `before/observations.json` へ記録。全工程が縦長、透明可動片が下絵を透かす、模様背景の白抜け、比較の別々の自動フィット、保存状態/切替保護の不足を確認した。保存切替保護の欠如は保存再開の実操作と既存ハンドラー読取による観察で、データ喪失を人の事故として記録してはいない。

変更したのは工程別の編集画面、印刷にも反映する作者指定の背景補正、ドラッグ/2点タップ/44pxハンドル、同縮尺の候補比較、実際の保存状態と未保存切替/離脱保護。本文16px・操作14px以上を基準とする共通トークンへ整理し、同梱の日本語フォントを画面にも使う。PDFの重いフォント処理と書き出しはWeb Workerへ移し、再生中に検査/手順を再計算しない。

### 描画・補正と残る条件

700×500pxの同じ白・透明・模様の開発者作成画像を使用。選択は元画像px `(420,140,180,180)`、台紙150×107.142857mm、右12mm。変更前後で画像・寸法・表示倍率fit・viewport・再生端点を一致させた。白と透明の設計は第5版とhashを保持し、模様へ背景補正を明示採用した場合だけ第6版/schema2/hash `c51f0ffcf01c834432f204c945c2d9ca72a14e15f0bf2617ccca3cc2ae16de02` へ変わる。

- 透明M1は画面でも白い紙。下の固定絵やスロットが透明画素を通して見える不一致を直した。
- B1の白抜けは作者が指定した単色、または背景用画像で補える。原絵のデータは変更しない。画像の配置は元絵と同寸なら同じ画素位置、異なる比率なら中央cover。指定領域以外は変更しない。
- 補正はSVG/PDFにも印刷され、8部品・材料枚数・機構は増えない。B1/M1内部に原絵を覆っていた白いIDラベルを外へ移した。
- 背景パッチとM1は白紙と画像を合成してから切り抜く。PDFの境界に出た白線はisolated Formで解消し、100/300dpiおよびSVGで境界画素を照合した。測定は `after/export/manifest.json`。Chromeの画面とSVGに残った同じ境界の白線も、元画像の範囲に限定したゼロ移動の合成処理で解消した。ぼかし・影・追加の紙は使わず、切り抜き前に紙と絵を一度合成する。実画素の比較は `preview-seam-diagnosis/` と `svg-browser-proof/`、再発防止はE2Eの境界RGB照合。
- 選択枠を横切る輪郭、隣接する絵の一部を含む切り抜き、移動後の模様の位相ずれは自動修復しない。同じ検証画像でも赤い残片と隣接する緑の円の切れは残る。枠の選び直し・補正の比較/却下へ戻れる。実物の摩擦や加工精度は未確認。

旧project version1を読み込み、既存doc/hash/版別記録を保持する。新しい書き出しはproject version2、補正未指定なら設計schema1のまま。背景画像のサイズ・実デコード・MIME・画素寸法・hashを照合し、破損/不足時は現在の作品を置換しない。AIのpatchへ背景変更権限を追加していない。

### U1〜U8と回帰

| 条件 | 確認した範囲 |
| --- | --- |
| U1 工程・主操作 | 1440×900、1280×800、1024×768、390×844、360×800、320×800の各3工程。横はみ出し・主操作の重なり・44px目標をDOMと実画面で確認。狭幅の自分の画像ボタンは作品より上 |
| U2 元絵・白抜け | 同じ3画像で元絵/始点/終点/B1/M1/実PDFを照合。作者指定画像・色の採用/却下、PNG/JPEG/WebPの正規化、背景破損と不一致の拒否 |
| U3 選択 | PCマウス、狭幅の2点タップ、矢印/Shift矢印、数値。150%閲覧倍率でsource pxを照合。44pxハンドルのサイズ変更、1動作1revision/Undo、pointercancel、工程変更で仮選択を取消 |
| U4 比較 | 候補のviewBox・原点・再生位相共通。狭幅は同じ表示枠で切替。採用/却下/Undo、古い候補の再計算、同hash/revisionでも別designIdへの遅延背景の越境拒否 |
| U5 保存・版 | v1移行、元絵/背景/記録の保存再開、閲覧操作で版不変。未保存切替を取消・保存容量エラー・破損読込でも保持。画像の失敗は画面内へエラーを表示。設計Undoで実物記録を消さない |
| U6 AI・失敗 | 未接続、HTTP/模擬モデル失敗、429、中断、IME Enterで誤送信なし、古いsession/run/承認、背景変更後の旧承認拒否。実Geminiは呼んでいない |
| U7 印刷 | 採用前は現設計、採用後は新版のPDFメタデータ/枚数/部品/手順。背景採用中に待機していた旧PDFを破棄。型紙枚数と説明4ページと総数を別表示 |
| U8 アクセシビリティ | computed colorの文字/境界/焦点、Tabの焦点とdialog復帰、reduced motion、位置outputの毎フレーム読み上げ抑制、320 CSS px。縮小viewportによる200%相当テストとは別に、Chromeの実際のtab zoom=2も確認 |

既存S1サンプル、S2自分の画像、S3上方向、S4サイズ/紙条件、S5採用/却下、S6旧出力/保存、S7失敗/中断、S8キット/版別記録を新工程から実行し、意味のあるassertを維持した。ナビゲーションと統一操作名に合わせて操作経路を更新した。旧Goalの証拠を上書きしないよう回帰の出力先をGoal003へ分けた。

- `npm run check`：lint / TypeScript / 9ファイル84テスト / 本番ビルド成功。`check-final.log`。
- `npm run test:e2e -- --workers=2`：最新UIで76/76成功（desktop38・mobile38）。`e2e-final.log`。開発中の部分実行やGoal002の件数を加算していない。
- `npm run examples`：4例を生成、全幾何検査pass・実物unknown。既存4設計hashを維持。`examples.log`。
- `npm run doctor` / `smoke:live` / `deploy:plan`：環境診断、ライブはSKIPPED/API0回、公開はdry-runのみ。Docker未導入。各同名ログ。

Chrome自身の200%は一時的なローカル拡張の `chrome.tabs.setZoom` と `getZoom=2` で確認し、通常1440px幅から720 CSS pxへリフローした。3工程と12回のTab移動を確認。`usability/browser-zoom-200.json` と実surface screenshotを保存した。モバイルの390×450への高さ縮小はソフトキーボードの占有領域を想定した模擬確認であり、実キーボード・実機確認ではない。フォーカスと横はみ出しの記録は `keyboard-area-simulation.json`。

### 応答性の実測

本番ビルドを単独のheadless Chromium、1440×900/DPR1で操作し、各入力・各操作を3回ずつ測った。選択/調整/採用は入力イベントから版更新と2回の描画フレーム、候補作成は候補DOMの出現まで、PDFはクリックからフォント取得・生成・実ダウンロードへ渡すまで。アップロード/実Gemini/利用者の操作時間/紙への印刷は含まない。

| 入力 | 選択確定 | 数値調整 | 候補作成 | 採用 | PDF |
| --- | ---: | ---: | ---: | ---: | ---: |
| pattern 700×500、0.35MP | 28.7ms | 25.0ms | 28.5ms | 27.9ms | 552.9ms |
| 同じ絵4200×2800、11.76MP | 28.2ms | 24.0ms | 28.3ms | 29.6ms | 1023.1ms |

値は各3回の中央値。PDF範囲は通常545.7〜555.2ms、大画像1009.8〜1049.0ms。両計測でmain threadの50ms以上のLongTaskは観測0。これはこのローカル環境・入力・計測区間の結果で、低速端末や実APIを含む製品全体の応答保証ではない。入力bytes/hash、CPU/Node/Chrome、cold/warmとフォント取得時間、全試行値は `usability/performance.json` と `performance-large.json` に記録した。

### 証拠と確認の境界

以下はすべて `artifacts/goal003/` 配下。総合 `manifest.json` から入力・設計版/hash・viewport・表示モード・確認種別へ辿れる。

| 内容 | 保存先 |
| --- | --- |
| 同条件の変更前後 | `before/{1440x900,390x844}/` / `after/{1440x900,390x844}/`：start、candidate、print、各3画像のoriginal/start/end |
| 背景の比較・採用後 | `after/*/pattern-repair-candidate.png`、`pattern-repaired-{start,end}.png`、`pattern-repaired.ugoku.json` |
| ブラウザから取得したPDF | `after/1440x900/{white,transparent,pattern-repaired}.pdf` |
| PDF全頁・SVG・共通描画の検査 | `after/export/{white,transparent,pattern}.pdf`、各 `-page-1.png`〜`5.png`、SVG、設計JSON、manifest |
| 既存S1〜S8の証拠 | `regression/{desktop,mobile}/`、`workshop-regression/`、`server-regression/`。模擬AIは明記 |
| 配置・コントラスト・焦点・200% | `usability/` のJSON、PNG、ログ |

画面は実Chromiumから取得。PDFは同じ保存設計から実出力し、3冊15ページをレンダリングして確認した。最終M1合成変更後は3冊の型紙1ページ目を再確認し、内容不変の説明2〜5ページは前回の確認と区別してmanifestへ記録。ブラウザのWorker経由で取得した3冊も全15ページを100dpiでレンダリングし、目視済みのcore出力とPNGバイトが15/15ページ完全一致した（`after/browser-pdf-equivalence.json`）。UIのSVGはブラウザ、印刷SVGの画素比較はlibrsvg、PDFはPopplerで確認したためレンダラー差も記録する。

初見の成人は参加していない。[説明なしで行う課題と観察票](design-and-usability.md#初見の成人による確認手順)を用意した。実Gemini・人による使用感・実スマートフォン・紙への印刷/工作・公開・Docker実起動は未確認。自動検証・開発者の実画面操作・模擬AIから、これらの成功を推定しない。実物は[既存手順](physical-validation.md)で50mmを実測し、工程順に組み立てて同じ版へ記録する。実API/クラウド作成/公開/pushの追加許可は受けていない。

現在使える範囲は、静止画像・矩形1か所・直線引っぱりタブの試作設計と、作者指定の背景補正、原寸キット、保存再開。万能な輪郭分離・背景復元ではない。大きい初期JS（約1.61MB、gzip約673KB）と別PDF worker約1.31MBがあり、低速回線・実機性能の評価は未実施。Git作成者情報は推測設定せず、コミット/push/公開はしていない。

## Goal 002 — 改善前の観察

2026-10-03、実装前に稼働中の `http://localhost:5173` をChromiumで操作。サンプルの再生・停止・終点、60mmへの距離変更、自作700×500px画像のアップロードと矩形選択を実行した。以下は画面とコード・PDFで確認した範囲であり、初見の利用者を対象にした評価ではない。

| 再現操作 | 観察 | 制作への影響 |
|---|---|---|
| 初期画面で距離とサイズを編集 | 距離mm・幅mm・紙枚数が主操作で、希望文から手動候補を作れない | どの寸法を変えるか作者が判断する必要があった |
| 自作画像を入れ矩形を選ぶ | 白い元位置と背景付き矩形が移動する。元画像専用表示がない | 絵への処理と意図した見え方を照合しにくかった |
| カメを終点へ動かし型紙と比較 | 選択の切れ目で首が離れる。正面に型紙の切り込みと台紙外の引き手が出ない | 完成予定の姿と実構造を同時に判断できなかった |
| 希望文とサーバーのpatch検査を照合 | 入力locks以外の「絵の大きさ維持／紙を増やさない」は文脈のみ | 語句で希望した保護条件がサーバー強制条件になっていなかった |
| PDFの工程3→4を開く | 各工程の部品の一部を描く静止図。前工程から追加した関係が読み取りにくい | ガイドを残して接続片を通す順序・接着する面の判断が必要だった |

証拠は `artifacts/goal002/before/{start,end,own-art,invalid-travel}.png`、操作後の `observed-ui.txt`、改善前のPDFと設計/検査/レンダリングは `artifacts/goal002/before/examples/`。テスト画像は開発者作成であり一般利用者の作品ではない。

開始HEADは `c7f1149508e0ef7a31d159f2e64450fceefbd3e0`、元ブランチは `feat/001-product-mvp`。既存62ファイルのステージ内容は index tree `2f738cdf43c0fc7db4aa59443a39b656670a9dae`。Goal002は `feat/002-creator-value` でその上に未ステージ差分として作業し、既存indexを変更しない。以降のGoal001記録は前段の実施履歴として保持する。

## Goal 002 — 実装と受入結果

実装した変更は5点。①自分の絵→矩形選択→方向/大小→確認→印刷の導線と数値設定の段階表示、②元絵・両端・切り込み・引き手を同じmm配置で確認、③自然語の条件を保護する手動支援とサーバー側AI候補、④前工程/追加部品/後工程を示す試作キット、⑤実物記録の対象版保持と古い非同期応答の無効化。

| シナリオ | 確認種別と結果 | 根拠 / 未確認の範囲 |
|---|---|---|
| S1 サンプルから型紙 | 自動：成功 | 主操作「もう少し大きく」→比較→却下/採用→原寸PDF。初見の人が迷わないかは未確認 |
| S2 組み込み以外の画像 | 自動：成功 | 自作640×900ランタンと640×480非対称画像を通常の画像検証APIへ入力、選択/方向/サイズ変更→PDF。一般利用者の作品ではない |
| S3 上方向 | 自動＋描画目視：成功 | ランタンを上18→23mm、気球を上20mm。ガイド・裏面・型紙・部品ID・工程図の整合。紙の実動作は未確認 |
| S4 サイズ/紙の保護と衝突 | 自動（手動支援）＋模擬AI：成功 | 20→25mmで絵の配置と紙1枚を維持。190×220mm/紙1枚は違反を表示、作者が上限の固定解除→2枚へ変更後に採用。40mm希望への28mm代案を別表示。実Gemini未確認 |
| S5 却下/採用と出力更新 | 自動＋模擬AI：成功 | UIのHTTP模擬で却下/採用、サーバーの模擬モデルは実コアを呼び出し、失敗候補の検査から26mmへ修正。却下は元設計不変、採用後PDF/SVG/手順のhashを照合 |
| S6 古い出力と保存再開 | 自動：成功 | PDFフォント取得を遅延→編集→旧PDF破棄。画像/選択/固定条件/版を保存再開。同hashの新revisionでも古いAI結果・承認を拒否 |
| S7 未対応/通信/中断 | 自動＋模擬通信：成功 | 回転依頼から明示的な直線案選択、AI未接続、通信失敗/429、中断、旧session作成応答の競合。編集保持。実プロバイダーでの障害挙動は未確認 |
| S8 試作キットと記録 | 自動＋PDF目視：成功、実物：未実施 | 8部品、校正、材料、4ページの説明書、接着面、通す順、両端/保持/手修正欄。メモを記入した版を保持しundoでも記録を消さない。組み立て成功の証拠にはしていない |

受入操作は `tests/e2e/creator.spec.ts`、既存回帰は `workshop.spec.ts` と `ai.spec.ts`。自然語保護/相対値/否定/紙枚数の不変条件は `packages/core/src/intent.test.ts`、部品保持/表裏/工程は `assembly.test.ts`、サーバーの実ツール往復は `apps/server/test/intent-loop.test.ts`。数値項目を詳細設定へ移したため旧E2Eには開く操作を追加した。プレビューはpxからmm座標へ統一し、移動量だけでなく画像のcontain倍率と原点も照合するテストへ変更した。失敗テストを削除していない。

### 自然語からの変更例と証拠

- 手動支援（AIなし）：「もう少し大きく。絵の大きさを保って、紙は増やさない」→サンプル20→25mm、160×110mm/型紙1枚維持。`browser/desktop/sample` は第2版、hash `58c99d184f3c8bc987b43dbd8075439acb94e811d6203da6e45624bc83a5f40f`。
- 模擬モデル通信（実Geminiではない）：70mmの候補で実際の幾何違反→検査を返す→26mmの代案、元の絵の大きさと型紙上限維持→採用。`mock/accepted` は第2版、hash `819fc10baf540f512a0749812e731dc7d3e5dd35b6cf3f0c6277e56648af659b`。`mock/proposal-run.json` に実ツールイベント、`mock/evidence.json` に模擬であることを明記。70mm達成と表示しない。意図的な失敗を本番ロジックに組み込んでいない。
- 自作ランタン（手動支援）：上18→23mm、作品120×160mm/型紙1枚維持。`browser/desktop/own-up` は第11版、hash `bff853a60b71a1c16d302bc3d689e332c0f4d9b7b6c1607738cde773bf036328`。

以下のパスはすべて `artifacts/goal002/` 配下（Git対象外）。`manifest.json` は設計ID・版・完全hash・方向・枚数・fail/unknownを対応付ける。

| 対象 | 実際のファイル |
|---|---|
| 改善前の画面 | `before/start.png`、`before/end.png`、`before/own-art.png` |
| 同じ形状で改善前後の型紙・手順 | `before/examples/turtle.pdf` / `after/turtle.pdf`。両方第1版/hash `3787f166…`を維持し、説明を改善。各 `.design.json` / `.checks.json` と `*-page-*.png` |
| 主操作と候補の画面 | `browser/desktop/sample-start.png`、`sample-candidate.png`、`sample-kit.png`。同名 `mobile/` も保存 |
| 自作画像・上方向の完成予定 | `browser/desktop/own-up-developer-source.png`、`own-up-front.png`、`own-up-back.png`、`own-up-instructions.png` |
| ブラウザ操作から出したキット | `browser/desktop/{sample,own-up}.pdf`、`.design.json`、`.checks.json`、`.assembly.json`、`.ugoku.json`。PDF各頁は `*-page-1.png`〜`5.png` |
| 上方向の別画像キット | `after/upward-balloon.pdf`、`upward-balloon-1.svg`、`upward-balloon-2.svg`、`upward-balloon-assembly-1.svg`〜`6.svg`、対応JSON |
| 模擬AIの前後 | `mock/before.design.json`、`before.svg` / `accepted.design.json`、`accepted.svg`、`accepted.pdf`、`assembly.before.json` / `assembly.accepted.json` |

画面は実際に開いて確認。4つのexamples全22ページ、模擬AIの5ページ、ブラウザから取得した2冊全10ページをレンダリングして目視した。日本語の欠け、部品ID、余白、表裏、工程前後を確認。PDFメタデータを含む全バイトの一致は要件にせず、設計hashと形状・画像画素を検証した。省略時サンプルのPDF/SVGに別々の絵を描く実装も共通PNGへ修正し、PDF内の展開画像の画素一致をテストした。

### コマンドと状態

- `npm run check`：lint / typecheck / 単体・統合75件 / 本番ビルド成功。ログ `check-final.log`。
- `npm run test:e2e -- --workers=2`：全体42件成功（PC21・狭い画面21）。ログ `e2e-final.log`。その後のAI接続競合修正は、追加回帰2件を含むAI16件を最新ビルドで再確認し全件成功。ログ `e2e-ai-final.log`。新旧44ケースに実行証拠があるが、全体44件を一度に再実行した結果ではない。
- `npm run examples`：4例を生成。全幾何検査pass、物理unknown。旧3例のhashはGoal001のまま。ログ `examples.log`。
- `npm run doctor`：Node24.20.0/npm11.19.0、AI無効、Dockerなし、PDF rendererあり。ログ `doctor.log`。
- `npm run smoke:live`：SKIPPED、API呼び出し0回。`npm run deploy:plan`：dry-runのみ。ログ `smoke-live.log` / `deploy-plan.log`。
- `git diff --check` / `git diff --cached --check`：成功。元の62ファイルのindex treeは開始時と一致。Goal002追加差分は未ステージ/未追跡のまま保存。

秘密情報・Git・依存キャッシュ・生成物を除外した73ソースファイルを `/tmp/ugoku-kami-goal002-clean-ghzjleev` へコピーし、`npm ci` → `npm run check` → `npm run examples` → `npm run smoke:live` を実行した。lint/typecheck/75テスト/ビルド成功、4例の設計JSON全文・hashが元環境と一致。smokeはAPI0回でスキップ。ログ `clean-verification.log`。この清浄環境ではブラウザE2Eを重複実行していない。

ローカル機能・自動検証・模擬AIは上記範囲で確認済み。実Geminiは明示された有料実行許可と設定がなく未確認。人による利用確認は参加者未確保で未実施、実物も未実施。利用確認の同意・比較順序・測定・中止を含む手順は `docs/physical-validation.md`。Cloud Run公開/URL確認とGitHub上のCIは未実施。Dockerコマンドがなくビルド/実起動も未実施。Git作成者名・メールは引き続き未設定で、コミット・push・PRはしていない。

### 残る制約と解釈の境界

重大な自動回帰失敗は残っていない。ただし「作者の意図を失わず誰でも組み立てられる」という製品価値を、人や実物で検証したとは結論しない。矩形の背景、白く残る元位置、切れて見える首などの輪郭は機構の限界として画面で確認できるようにした。自作ランタンの型紙には選択境界の細い橙色線が残るため、必要なら枠を広げて実物で確認する。背景生成や前板で隠した演出は追加していない。

自然語は対応範囲を限定した解釈器で保護条件を確定する。読み取れない言い回し・矛盾は再指定が必要で、任意の文章の意味を保証しない。紙枚数の削減に絵の縮小を使わず、距離だけを探索する。固定条件の緩和は利用者が詳細設定で解除・変更する。1mm刻みと棚詰め法の探索失敗は、実現不可能の証明ではない。

摩擦・強度・折り精度・接着剤・指の入りやすさはunknownのまま。実物記録を追加しても機構全般をpassへ変えない。実ブラウザはChromiumのPC/モバイルエミュレーションで、Safari/Firefoxや実機操作は未確認。UIバンドル約1.64MB（gzip約700KB）で、低速端末・低速回線の性能評価は未実施。既存の保存・API制限・認証・Docker準備の境界を維持する。

## Goal 001 — 実施履歴

検証日: 2026-10-03。Node v24.20.0、npm 11.19.0、Linux/WSL。実API呼び出し、課金操作、公開デプロイは0回。

## 完了判定

| 項目 | 判定 |
|---|---|
| ローカル機能 | 実装・手動経路のE2E確認済み |
| 自動検証 | lint / typecheck / 単体・統合 / 本番ビルド / Chromium E2Eを実行 |
| 手動モード | AIキーなしで画像→編集→検査→PDF→保存/再開を確認 |
| 模擬AI | 実コアツールを動かす通信モックと、UIのHTTPモックを区別して確認 |
| 実Gemini | 未確認・許可/認証待ち。通常smokeがスキップすることのみ確認 |
| 実物 | 未検証。印刷倍率・50mmの実測・組み立て・写真は未記入 |
| 公開 | 未実施。Cloud Run URLなし。Dockerビルド/起動も未実施 |

## 実行したコマンド

- `npm ci` — 成功。固定lockfileから導入。監査結果は実行時0 vulnerabilities。
- `npm run doctor` — 成功。秘密値表示・ネットワーク・有料API呼び出しなし。Docker利用不可を検出。
- `npm run check` — ESLint / TypeScript / Vitest / 本番ビルド成功。最終件数はこの文書末尾に記録。
- `npm run test:e2e -- --workers=2` — ChromiumのPC 1440pxと390px幅のモバイルエミュレーション。実機Safari/Firefoxは未実施。
- `npm run examples` — 水平・垂直・長い日本語タイトル/回転配置の3ケースを生成。全幾何検査pass、物理検査unknown。
- `pdftoppm -png -r 110 …` — PDFを画像へレンダリングして各ページを目視確認。水平5ページ、垂直5ページ、追加ケース6ページ。
- `npm run smoke:live` — 明示opt-inなしでSKIPPED。実API呼び出し0回。
- `npm run deploy:plan` — 計画と未設定項目を表示。gcloudを呼ばず、リソース変更なし。
- `git diff --check` — 空白の不正なし。

開発中に検出した、PDF日本語の文字欠け、狭い部品ラベルの重なり、裏面配置の左右、画像の縦横比による座標ずれ、検査違反中の印刷図エラー、古い提案/承認の競合を修正した。初期の失敗テストを成功件数へ混ぜず、修正後に検証を実行した。

## 主な失敗経路を検証

設計改ざん・未対応版・非有限値・過大値・不正参照・固定条件・紙面超過を拒否する。連続移動区間のガイドへのかかりと背面の干渉、画像pxからmm、原寸A4/pt、同一入力の再現性を検査する。AIは認証、無キー、429、タイムアウト、拒否、不正ツール/引数、同じ失敗/設計の反復、上限、中断、二重依頼、古い承認を検証する。モデルの文章で幾何failや固定条件を通過させない。

UIでは、自作の非対称画像を入力して数値で選択しPDF化する。縦横比を変えて移動量と印刷範囲を照合する。保存/再読込、JSON持ち出し/読み込み、保存容量エラー、保存削除、HTMLを含むAI文のテキスト表示、通信失敗からの復帰を確認する。AIの応答待ちに手動編集→やり直し（同じhash・新しい版）を行っても旧結果は適用しない。

## 実際の成果物

生成物はGitへ入れず `artifacts/` に保存する。利用者のブラウザから取得するファイルは通常のダウンロード先に保存される。

- `artifacts/examples/turtle.pdf`、`turtle-1.svg`、`turtle.design.json`、`turtle.checks.json`
- `artifacts/examples/vertical.pdf`、`vertical-1.svg`、設計/検査JSON
- `artifacts/examples/heldout-wide-long-title.pdf`、`heldout-wide-long-title-1.svg`、`heldout-wide-long-title-2.svg`、設計/検査JSON
- `artifacts/examples/rejected-travel.checks.json` — 移動距離超過時の検査理由
- `artifacts/examples/*-page-*.png` — PDF各ページのレンダリング
- `artifacts/screenshots/desktop-workshop.png`、`mobile-workshop.png` — 画面全体
- `artifacts/screenshots/desktop-viewport.png`、`mobile-viewport.png` — 最初の画面
- `artifacts/screenshots/desktop-uploaded.png`、`mobile-uploaded.png` — テスト用画像を開いた画面
- `playwright-report/index.html` — 最新のブラウザテストレポート
- `docs/architecture.svg` / `artifacts/architecture.png` — アーキテクチャ図

画面とPDFのファイルを生成するだけでなく、画像を開いて文字、重なり、余白、切れを目視確認した。

## 制約と未実施

- 幾何を満たしても紙厚・摩擦・加工精度・耐久性は保証しない。切り出しは矩形と白いマスク。自動の背景補完はしない。
- 選択解除は再選択待ちの下書き状態。確定するまでAI・保存・出力を無効にし、古い領域を出力しない。
- A4のみ。棚詰め配置は最適性を保証しない。失敗をすべての配置が不可能と扱わない。
- ブラウザ容量には上限がある。写真・画像の大きいプロジェクトはJSONに書き出す。クラウド保存なし。
- AIに画像本体を送らない。任意の希望文の意味を決定的に保証するものではなく、未対応の語やモデル判断により希望の書き直しが必要な場合がある。
- セッションと回数制限はインスタンス内メモリ。再起動/複数インスタンスで共有されず、サービス全体の課金上限ではない。
- 日本語PDFライブラリを含むUIバンドルは約1.52MB（gzip約629KB）。低速回線での性能検証は未実施。
- GitHub Actions定義は用意したがGitHub上の実行は未実施。Dockerがなくコンテナ検証も未実施。
- 実物、実Gemini、公開、デモ撮影、提出は未実施。手順は `physical-validation.md` / `deployment.md` / `demo-and-submission.md`。
- Git作成者名・メールがないためコミットは未実施。push/PRは許可がなく未実施。

## 最終再検証

最終ソースで `npm run check` 成功（4ファイル・46テスト）。`npm run test:e2e -- --workers=2` は32/32成功（PC16・狭い画面16）。API課金は0回。ログは `artifacts/verification/{doctor,check,e2e,smoke-live}.log`。

別ディレクトリ `/tmp/ugoku-kami-clean-a59htdhp` で `npm ci` から新規導入し、`doctor / check / examples / smoke:live` を実行した。46テスト・lint・typecheck・ビルドが成功。3サンプルの設計JSONとハッシュは元の作業ディレクトリと完全一致した。PDFメタデータを含めたバイト一致は要件にせず、設計データの同一性を検証した。別ディレクトリでのブラウザE2Eは重複実行していない。

`npm run dev` の起動、ViteからAPIへのプロキシ、開発画面の表示も確認。本番形態はE2Eの `npm run build && PORT=4173 AI_ENABLED=false npm start` で同一オリジンとして確認した。
