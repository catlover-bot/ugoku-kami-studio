# 公式資料・依存バージョンの確認

確認日: 2026-10-03。実環境 Node v24.20.0 / npm 11.19.0。具体的な直接依存は `package.json`、間接依存は `package-lock.json` に固定する。バージョンは npm registry の公開メタデータで存在と engines/peerDependencies を調べ、導入と型検査・ビルドで組み合わせを検証する。

| 対象 | 確認資料 | 判断 |
|---|---|---|
| Node 24 | https://nodejs.org/en/about/previous-releases | Node 24 系の環境を採用 |
| Vite 8.3.2 | https://vite.dev/guide/ | Node 20.19+ / 22.12+ 要件に Node 24 が適合 |
| Vitest 5.0.3 | https://vitest.dev/guide/ | engines の Node 24 系条件を満たす |
| Fastify 5.12.5 | https://fastify.dev/docs/latest/Reference/LTS/ | 現行メジャーを採用 |
| TypeScript 5.9.3 | npm registry / typescript-eslint peerDependencies | ESLint連携が対応する `<6.1` の範囲を採用 |
| Google GenAI SDK 2.27.0 | https://ai.google.dev/gemini-api/docs/libraries | 公式 `@google/genai`、サーバー側のみ |
| Function calling | https://ai.google.dev/gemini-api/docs/function-calling | 実際のコアツールへ接続し、会話部品とcall IDを保持 |
| Structured output | https://ai.google.dev/gemini-api/docs/structured-output | JSON schema だけに依存せず、受信後に値と固定条件を再検査 |
| Agent安全性の参考 | https://google.github.io/adk-docs/safety/ | ADKは導入せず、許可ツール・最小権限・承認境界を独自実装 |
| Cloud Run | https://cloud.google.com/run/docs/container-contract | 0.0.0.0 / PORT、揮発性ファイルシステム前提 |

GeminiモデルとSDKの実装詳細は `apps/server/docs` の確認記録も参照。モデルの使用権限や利用可能性はプロジェクトごとに異なるため、ドキュメントの確認と実API接続成功は区別する。この開発では実APIを呼ばない。

## 日本語フォント

- Zen Kaku Gothic New Regular、Copyright 2022 The Zen Kaku Gothic Project Authors。
- 取得先: https://github.com/google/fonts/tree/main/ofl/zenkakugothicnew
- 配布・埋め込み条件: https://github.com/google/fonts/blob/main/ofl/zenkakugothicnew/OFL.txt
- SIL Open Font License 1.1。フォントの同梱と文書への埋め込みが許される条件を確認し、原ファイルと著作権表示・OFL全文を `apps/web/public/fonts/` に同梱。
- バイナリ SHA-256: `b840cd07a67d89cacca44249ae49aa99ee7640eb5ce623be8d8983d6aabac801`。
- PDFの日本語は fontkit の全文字埋め込み（サブセットでは文字欠けが生じたため）で描画する。PDF自体の内容・レイアウトの再現性と、作成日等メタデータを含むバイト同一性は別の扱い。

サンプルのカメは本実装のための自作SVG。第三者のコード・図・型紙の転載は行っていない。機構は初期の幾何モデルとして設計したもので、既製の実証済み型紙ではない。
