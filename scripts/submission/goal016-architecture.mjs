/** Draw the current system, not a screenshot. No product/Cloud/AI access. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {argumentsFor,save,hash} from './goal016-media.mjs';
const args=argumentsFor(process.argv.slice(2),['assets-root']);const assets=resolve(args['assets-root']);
const out=join(assets,'public/goal016-final'),work=join(assets,'private/goal016-final/architecture');
await mkdir(out,{recursive:true});await mkdir(work,{recursive:true,mode:0o700});
const font=(await readFile(new URL('../../apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf',import.meta.url))).toString('base64');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const box=(x,y,w,h,title,lines,accent=false)=>`<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${accent?'#edf5f1':'#fff'}" stroke="${accent?'#24685c':'#c4ceca'}"/><text x="${x+24}" y="${y+40}" class="title">${esc(title)}</text>${lines.map((line,i)=>`<text x="${x+24}" y="${y+78+i*31}" class="body">${esc(line)}</text>`).join('')}</g>`;
const arrow=(d,label,x,y)=>`<path d="${d}" class="arrow"/>${label?`<text x="${x}" y="${y}" class="label">${esc(label)}</text>`:''}`;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1060" viewBox="0 0 1600 1060"><defs><style>@font-face{font-family:Zen;src:url(data:font/ttf;base64,${font})}text{font-family:Zen,sans-serif;fill:#202725}.title{font-size:27px}.body{font-size:23px}.label{font-size:20px;fill:#55615d}.arrow{fill:none;stroke:#77837d;stroke-width:2;marker-end:url(#a)}</style><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="#77837d"/></marker></defs><rect width="1600" height="1060" fill="#f2f4f3"/><text x="54" y="66" font-size="42">うごく紙工房の構成</text><text x="54" y="105" class="body">AIが提案し、コードが検査。採用と原本の管理は作者の操作で。</text>
${box(54,155,450,235,'ブラウザ',['絵・範囲・方向・距離を編集','現在／希望／候補を比較','IndexedDB：作品と再開位置','同版PDF・取得版の組み立てガイド'],true)}
${box(580,155,430,235,'Web / API · Cloud Run',['東京 · アプリ用サービスアカウント','コード認証・受付条件・送信制御','共通コアで変更案を再構成・検査','作者の採用までは原本を保持'])}
${box(1090,155,455,235,'Vertex AI · Gemini',['global エンドポイント','希望文＋設計条件から変更案','画像本体はモデルへ送らない','ブラウザの個人APIキーは不要'])}
${arrow('M504 255H578','希望',517,235)}${arrow('M1010 255H1088','依頼',1028,235)}
${box(580,455,430,205,'非公開GCS台帳',['依頼・送信・費用予約を永続化','不明な使用量は予約を保持','再起動しても履歴と上限を継承'])}
${arrow('M795 390V453','送信前の予約 / 観測',812,426)}
${box(54,455,450,205,'ブラウザとAPIの共通コア',['幾何・干渉・紙面配置・固定条件','希望への一致と代案を区別','PDFの設計ID・版・hashを照合'])}
${box(1090,455,455,205,'監視Job + Scheduler',['アプリとは別の権限で監視','費用・期限・観測状態を確認','監視と期限停止の予定を保持'])}
${arrow('M1090 560H1012','観測',1028,538)}
${box(54,745,724,206,'観測に失敗したとき',['欠測を0扱いせず、専用サービスとAIを停止','台帳・復旧に必要な素材を残す','状態と費用を確かめ、承認した手順で復旧'],true)}
${box(822,745,723,206,'予算・期限による終了',['費用・期限の停止条件を維持','専用サービスを先に停止','終了処理と、残存物の確認を分けて記録'])}
${arrow('M1230 660V704H416V743','',0,0)}${arrow('M1310 660V704H1183V743','',0,0)}
<text x="54" y="1006" class="label">説明図。Cloud Consoleの実画面ではありません。原寸PDFの取得と、紙の実物動作は別の確認です。</text></svg>`;
const browser=await chromium.launch({headless:true});
try{const page=await browser.newPage({viewport:{width:1600,height:1060},deviceScaleFactor:1});await page.route('**/*',r=>r.abort());await page.setContent(`<html><style>body{margin:0}</style>${svg}</html>`);await page.evaluate(()=>document.fonts.ready);assert.equal(await page.locator('svg').count(),1);const png=await page.screenshot();await writeFile(join(out,'architecture.png'),png,{flag:'wx'});await writeFile(join(work,'architecture.svg'),svg,{flag:'wx',mode:0o600});await save(join(work,'provenance.json'),{format:'ugoku-goal016-architecture-v1',generatedAt:new Date().toISOString(),kind:'locally authored technical diagram',file:'public/goal016-final/architecture.png',sha256:await hash(join(out,'architecture.png')),width:1600,height:1060,cloudCalls:0,modelCalls:0,semanticScope:['Tokyo Web/API distinct from Vertex global','Observation failure stops service/AI and retains recovery materials','Budget/deadline terminal path remains distinct','Unknown usage is retained, not treated as zero']});console.log(JSON.stringify({status:'diagram-rendered',file:join(out,'architecture.png')}));}finally{await browser.close();}
