# 試作004：白背景の魚を右へ動かす

この1件は**手動で決めた試作設計**です。実Geminiの採用結果ではなく、印刷・組み立て・撮影も未実施です。既存の直線引きタブ機構を使い、魚全体が選択枠に収まる開発者作成のSVGを使用しました。個人画像・画像生成APIは使っていません。

設計は `prototype-004-fish`、第1版、右15 mm、台紙160 × 110 mmです。

```text
87d67ffa2f65ce6d87ab3799fd1a3eaee1f130aada24321537b7c2fe475f50d5
```

## 印刷するファイルと同じ版の記録

成果物の基準フォルダは [artifacts/goal004/prototype](../artifacts/goal004/prototype/) です。

| 用途 | ファイル |
|---|---|
| 通常アプリから取得する印刷PDF | [kit.pdf](../artifacts/goal004/prototype/kit.pdf) |
| 同じexport関数で先に準備したPDF | [core-kit.pdf](../artifacts/goal004/prototype/core-kit.pdf) |
| 画像込みの再開用プロジェクト | [prototype.ugoku.json](../artifacts/goal004/prototype/prototype.ugoku.json) |
| 設計本体・検査 | [design.json](../artifacts/goal004/prototype/design.json) / [checks.json](../artifacts/goal004/prototype/checks.json) |
| 材料と部品別の工程・空欄記録票 | [assembly-and-record.md](../artifacts/goal004/prototype/assembly-and-record.md) |
| 正面の予定図 | [始点](../artifacts/goal004/prototype/expected-start.png) / [終点](../artifacts/goal004/prototype/expected-end.png) |
| 実物確認の空欄JSON | [physical-record-blank.json](../artifacts/goal004/prototype/physical-record-blank.json) |
| 寸法と輪郭の計算上の確認 | [construction-audit.json](../artifacts/goal004/prototype/construction-audit.json) |
| 生成区分・版・hash・出力の対応 | [manifest.json](../artifacts/goal004/prototype/manifest.json) |

`kit.pdf` は通常UIの「PDFをダウンロード」から取得済みです。ブラウザの既定名は `prototype-004-fish-r1.pdf` です。[browser-proof.json](../artifacts/goal004/prototype/browser-proof.json) に版・hash・PDFメタデータと画素比較を残しました。PCと390 px幅のChromiumの両方で取得したPDFは、準備版の全5ページと100 dpiのRGBA画素が一致しました。型紙1ページと説明4ページ、計5ページです。型紙は1ページ目だけを指定厚さの紙に、説明4ページは別の普通紙に印刷できます。

元画像を含むプロジェクトを「保存と再開」→「プロジェクトを読み込む」で開き、工程3へ進むと同じ版のPDFを再取得できます。距離などを変更した場合は新版になります。新版を印刷するときは古いPDFと混ぜないでください。

## 材料と実際の切り出し寸法

型紙用A4厚紙1枚（設計の紙厚仮定0.25 mm）、少量ののりまたは両面テープ、定規、はさみ、カッター、カッターマット、先の丸い折り筋用の道具を使います。説明は普通紙4ページまたは画面で参照します。紙厚・接着剤の厚みは実物で測って記録してください。

| 部品 | 個数 | 平らな型紙の寸法 |
|---|---:|---:|
| B1 固定台紙 | 1 | 160 × 110 mm |
| M1 魚を印刷した可動紙 | 1 | 60 × 42 mm |
| T1 引っぱりタブ | 1 | 149 × 14 mm |
| G1・G2 ガイド | 各1 | 各10 × 27.6 mm |
| S1・S2 抜け止め | 各1 | 各8 × 22 mm |
| C1 接続片 | 1 | 8 × 14 mm |

M1は矩形の紙として切ります。魚の輪郭に沿って切る型紙ではありません。白背景なので、開始位置にも移動後にも選択枠を横切る輪郭はありません。

## 組み立てで合わせる箇所

全工程と今回加える部品の図はPDFの2〜5ページと [部品別の手順](../artifacts/goal004/prototype/assembly-and-record.md) にあります。

1. 100%で印刷し、50 mm校正線を測ります。B1の25 × 3 mmの切り込みも切ります。破線は折り線です。
2. G1/G2の両端5 mmを足にし、内幅15.6 mm、高さ1 mmのトンネルに折ります。C1は6 / 2 / 6 mmのZ形です。
3. B1の上辺を上に保って左右に裏返します。裏面の左上基準でG1の足は `(98,42.2)` と `(98,62.8)`、G2の足は `(73,42.2)` と `(73,62.8)` mm。それぞれ10 × 5 mmです。ガイド足の無地面だけを接着し、C1/S1/S2をまだ付けていないT1を通します。T1の印刷面をB1に向けます。
4. C1のM1側の足を立てて裏からB1の切り込みへ通し、Z形に戻します。T1表示の**裏の無地面**をT1のC1印へ、M1表示の**印刷面**をM1の無地の裏へ接着します。M1を元位置に合わせます。B1とC1中央2 mmには接着しません。
5. 通したT1の同名印へS1/S2の中央14 mmを接着します。両側各4 mmの羽は接着しません。S2がG2に当たる位置が始点、15 mm引いてS1がG1に当たる位置が終点です。
6. 乾燥してからゆっくり動かします。引っかかる場合は力で引かず、糊・向き・折り幅・紙厚を確認し、実際に直した箇所を記録します。

## 計算で確認できた範囲と実物待ちの範囲

15 mmの移動全体でT1は両ガイドに残り、引き手は台紙の外へ始点18 mm、終点33 mm出ます。C1の移動軸方向8 mmは切り込みの両端に各1 mmの余裕を残します。M1は開始・終了ともスロット全体を覆います。S1/G1とS2/G2の理想化された接触位置、ガイド足が台紙内にあること、全8部品が型紙1枚に載ることを既存の検査関数で確認しました。

通常UIから取得したPDFを100 dpiで全5ページレンダリングし、原絵・部品名・接着面・裏面座標・校正線が読めることをエージェントが画像表示で確認しました。[PC](../artifacts/goal004/prototype/browser/desktop/) と [狭い画面](../artifacts/goal004/prototype/browser/mobile/) の実ブラウザ操作では、画像を開く・始点/終点・裏面・手動候補を却下・印刷・空欄フォーム・プロジェクト再出力を確認しました。横方向のはみ出し・ページエラーはなく、版/hashと元画像が保たれ、実物記録は0件、モデル呼び出しも0件です。狭い画面はデスクトップChromiumの390 × 844 CSS pxで、実スマートフォンや初見の人の確認ではありません。

型紙寸法や機構をこの試作のために変更していません。高さ1 mmのガイドを折る作業性、C1の通しやすさ、紙と接着剤の厚み、摩擦・たわみ・強度は実物未確認です。画面の予定図は写真でも動作確認結果でもありません。

L1の開始条件には距離増加の余地があります。20 mmと25 mmは、幅・高さ・選択領域・方向・紙厚・すき間・型紙1枚の上限を保ったまま幾何検査の失敗がありません。これは実Geminiに返させる固定回答ではなく、開始設計の成立余地の事前確認です。70 mmは実際にガイド足と切り込みが台紙内の条件を満たさず失敗します。実際のAPI実行区分はライブ記録で別に管理します。

## 人が確認して記録すること

まず上記PDFの第1版を印刷し、50 mm校正線の実測、材料と紙厚、工程外の切り直し・折り直し・接着位置変更を記録します。始点・途中・終点の引っかかりと両ガイドの保持を確認し、10往復程度の初期チェックで実際の回数と前後の変化を残します。耐久性の保証とはしません。正面・裏面・始点・終点を撮影し、校正線も必要に応じて別に残してください。

同じプロジェクトを開いた工程3の「実物でためした記録」で、設計第1版・上記hash・`prototype-004-fish-r1.pdf`を確認してから、実際に試した欄だけを記入します。「この設計版に記録を追加」を押し、ブラウザへ保存するかプロジェクトを書き出すと記録が残ります。空欄票や予定画像は実物記録へ自動登録していません。

準備を再現するコマンドは以下です。有料APIへは接続しません。別版の `kit.pdf` が出力先にある場合は混在を防ぐため停止します。

```sh
npx tsx scripts/prepare-prototype.ts
# ビルド済みの実アプリでPC/狭い画面を操作し、kit.pdfと比較記録を取得
npx tsx scripts/capture-prototype.ts
# 別の準備フォルダに出力する場合
npx tsx scripts/prepare-prototype.ts --out artifacts/goal004/prototype-recheck
npx tsx scripts/capture-prototype.ts --out artifacts/goal004/prototype-recheck
```

画面収集は既存の `apps/web/dist` を使用します。最新コードを収集するときは先に `npm run build` を実行してください。AIは設定値を直接falseに固定し、`.env`を読み込まず、一時的なlocalhostサーバーだけを起動します。PDF描画比較には `pdftoppm` が必要です。

実Geminiの採用版が得られた場合は、そのプロジェクトを `writePrototypeBundle(project, { outDir, mode: 'live-gemini', liveRunId })` へ渡し、通常UIで同じ版を印刷します。手動の第1版の成果物は残し、未実施の実物記録を成功扱いへ変更しません。
