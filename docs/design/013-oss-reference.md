# Goal013: OSS 操作原則の参照記録

確認日：2026-10-07（JST）。目的は、中央の作品と現在の操作に集中できる UI を自前で実装すること。各製品の画面、コード、CSS、アイコン、ロゴ、サンプル画像を取り込む変更ではない。製品への依存追加も行わない。

## 確認した状態と適用判断

| 参照先 | 確認方法・状態 | 採用する原則と適用先 | 採用しないもの |
| --- | --- | --- | --- |
| Excalidraw | 公式 Web アプリを Chromium で開き、空キャンバス→自分で矩形を描画→選択。上下の操作群と、選択時だけ現れる設定を実見。関連ソースも読む。 | 作品を主領域にし、表示倍率・戻す操作を作品の近くに置く。選択対象の設定を現在の操作に絞る。Preview / WorkbenchTools / 編集パネルに適用。 | 手描き風装飾、フォント、無限キャンバス、図形ライブラリ、共同編集機能。 |
| Penpot | 公式「The interface」の画面図・説明と sidebar/options ソースを確認。ログインした実アプリ操作はしていない。 | 選択対象に応じて同じ場所のプロパティを切り替える。保存状態はファイル単位で示す。Home のサムネイル・更新日時・作品ごとの操作に適用。 | レイヤー階層、プロトタイプ、コメント、チーム管理、左右両側の多数パネル。 |
| draw.io | 公式 Format panel の未選択／図形選択の画像を実見。Format.js の選択分岐とパネル切替、フォーカス復元を確認。実エディタの操作はしていない。 | 未選択では全体条件、選択後は対象の条件。同じパネルを使い、過去の条件を下へ積み増さない。紙面条件と画面の表示倍率を区別する。 | ステンシル・テンプレート、全項目を常時出す高密度パネル、デスクトップ専用ショートカットの必須化。 |
| Krita | 公式 5.3.0 マニュアルの View / Popup Palette と画像、KDE 公式ミラーの関連ソースを確認。デスクトップアプリは未実行。 | 作品の近くに表示操作を置き、作業の移動量を減らす。組み立て図の読取り・スクロールにも適用。 | 円形パレット、ブラシ機能、右クリック限定操作、主要操作を隠す canvas-only モード。 |
| Radix Primitives | 公式 Dialog デモで開く→Escape→起点へフォーカス復帰を実操作。Accessibility / Dialog / Dropdown Menu の説明と dialog.tsx を確認。 | 名前のある操作、キーボード到達、Escape で閉じる、起点へのフォーカス復帰。作品操作と既存 native dialog に自前実装。 | テーマやアイコンの流用。既存 HTML/React で実現できる範囲へのライブラリ追加。 |

実操作した Web アプリの配信 SHA は未確認。以下のソース SHA は読んだコードを固定するための記録で、配信画面と同一版であるとは主張しない。公式画像の観察とアプリの実操作も区別する。

## 一次資料・版・素材条件

### Excalidraw

- [公式アプリ](https://excalidraw.com/) / [公式ドキュメント](https://docs.excalidraw.com/)。画面では上部のツール、下部の倍率・undo/redo、選択時の設定を確認した。
- [LayerUI.tsx](https://github.com/excalidraw/excalidraw/blob/53973c3a423fbd75a4ce68107786b4fcb90e4968/packages/excalidraw/components/LayerUI.tsx)：`showSelectedShapeActions` による選択時の表示と Toolbar / Footer の分離を参照。SHA `53973c3a423fbd75a4ce68107786b4fcb90e4968`。
- [LICENSE](https://github.com/excalidraw/excalidraw/blob/53973c3a423fbd75a4ce68107786b4fcb90e4968/LICENSE)：MIT。コード等を複製する場合は著作権・許諾表示の保持が必要。ロゴ、外部ライブラリ素材、フォントや他者の描画について包括的な利用可とは扱わない。今回はいずれも不使用。

### Penpot

- [The interface](https://help.penpot.dev/user-guide/first-steps/the-interface/) / [公式ワークスペース図](https://help.penpot.dev/img/interface/workspace-dark.webp)。選択対象により Design Properties の内容が変わり、File Status と履歴は別の役割であることを確認。
- [sidebar/options.cljs](https://github.com/penpot/penpot/blob/2a6e92a7d9a5520365276f7b9a6ae59d478159ee/frontend/src/app/main/ui/workspace/sidebar/options.cljs)：選択数・対象種類に対応する分岐を参照。SHA `2a6e92a7d9a5520365276f7b9a6ae59d478159ee`。
- [LICENSE](https://github.com/penpot/penpot/blob/2a6e92a7d9a5520365276f7b9a6ae59d478159ee/LICENSE)：MPL-2.0。対象コードの配布には対象ソースと表示に関する条件がある。ブランドや画面内サンプルの条件はコードとは別に確認する必要があるため、画像・ロゴ・コードを取り込まない。

### draw.io

- [Format panel](https://www.drawio.com/docs/manual/editor/panels/format-panel/) の [未選択画像](https://www.drawio.com/img/blog/diagram-options.png) と [選択画像](https://www.drawio.com/img/blog/style-tab-shape.png) を参照。
- [Format.js](https://github.com/jgraph/drawio/blob/98f61bf853d770a1e44f808994672f8bb817252b/src/main/webapp/js/grapheditor/Format.js)：`immediateRefresh` の未選択・文字編集中・選択中の分岐とフォーカス復元を確認。SHA `98f61bf853d770a1e44f808994672f8bb817252b`。
- [LICENSE](https://github.com/jgraph/drawio/blob/98f61bf853d770a1e44f808994672f8bb817252b/LICENSE)：コードは Apache-2.0。複製時はライセンス、該当する表示・変更記録等の条件を確認する。[README の素材条件](https://github.com/jgraph/drawio/blob/98f61bf853d770a1e44f808994672f8bb817252b/README.md) はアイコン・ステンシル・テンプレートに別条件や第三者権利があることを明記している。Apache-2.0 だけで全素材を利用可とはしない。今回は素材・ロゴ・コード不使用。

### Krita

- [View メニュー](https://docs.krita.org/en/reference_manual/main_menu/view_menu.html) / [Popup Palette](https://docs.krita.org/en/reference_manual/popup-palette.html)：確認したマニュアルの表示版は 5.3.0。
- [kis_popup_palette.cpp（KDE 公式ミラー）](https://github.com/KDE/krita/blob/97f42ad6326a3cfc15d7f158678433608acf13ce/libs/ui/kis_popup_palette.cpp)：表示切替・fit・zoom の操作を参照。SHA `97f42ad6326a3cfc15d7f158678433608acf13ce`。Invent の本文取得ができず公式ミラーで確認した。
- [製品ライセンス](https://krita.org/en/about/license/) は全体を GPLv3 とし、個々のファイルには異なる許諾もあると説明する。上記ファイルの SPDX は LGPL-2.0-only。[マニュアルの素材方針](https://docs.krita.org/en/contributors_manual/krita_manual_readme.html) も画像と帰属表示の条件を定める。作家が自分の絵を所有することと、他者のサンプル画像を自由に取り込めることは別。コード・画像・ロゴ不使用。

### Radix Primitives

- [Accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility) / [Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) / [Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu)。ラベルは利用側で適切に付ける必要がある。
- [dialog.tsx](https://github.com/radix-ui/primitives/blob/c71610373b6aa17de24f5c7484ced5108160f12b/packages/react/dialog/src/dialog.tsx)：開いている間の focus trap、閉じた際の trigger へのフォーカス復帰を参照。SHA `c71610373b6aa17de24f5c7484ced5108160f12b`。
- [LICENSE](https://github.com/radix-ui/primitives/blob/c71610373b6aa17de24f5c7484ced5108160f12b/LICENSE)：MIT。複製する場合の表示保持条件はあるが、今回はコード・テーマ・アイコンを複製せず、依存も追加しない。

## このアプリでの境界

見た目の模写ではなく、選択に応じた操作、安定した作業領域、焦点を失わない対話を採る。白・中立色・teal の自前トークン、14〜16px のラベル、44px 以上の操作領域を用いる。最近の作品、選択、動き、候補比較、印刷・版を保持した組み立てガイドへ適用する。参考製品の機能の多さは持ち込まない。

DesignDocument・設計ハッシュ・mm 幾何・検査・採用・PDF・保存形式・実物記録の意味は参照 UI の都合で変更しない。工程の閲覧は製作完了を意味せず、表示倍率は紙の寸法を変えない。各実装とその確認結果は Goal013 の検証記録に分けて残す。
