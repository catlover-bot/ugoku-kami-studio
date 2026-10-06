/** Four editorial product images made only from retained real screenshots/PDF.
 * No app/API/model requests. Crops are CSS viewports; source pixels/text unchanged.
 * Usage: node scripts/submission/redesign-images.mjs --assets-root /absolute/artifacts/submission
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from '@playwright/test';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
assert.equal(process.argv[2],'--assets-root');assert(process.argv[3]);assert.equal(process.argv.length,4);
const assets=resolve(process.argv[3]);
const privateDir=join(assets,'private/material-redesign-20261006/images');
const outputDir=join(assets,'public/goal011/review-v2/images');
await mkdir(privateDir,{recursive:true,mode:0o700});await mkdir(outputDir,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const historical='private/goal010/browser-sequence-2026-10-05T09-11-37.048Z/recovery/';
const sources={
 selection:{path:'public/goal011/images/01-selection-local.png',expected:'b45f8c33e1aefb2d00685e748dd1299253f57122f86cf55b510a01962814731b'},
 exact:{path:'public/goal011/images/02-candidate-vertex.png',expected:'1df65765b0a698bce938448449c554fffb45baeab229e8193f1ae3a273942a88'},
 alternative:{path:'public/goal011/images/04-public-alternative-vertex.png',expected:'b803a5b7009e5b160d8b33881fcfddf4bd0420458ccdfdd1271784f9159ae693'},
 guide:{path:historical+'reloaded-guide.png'},
};
for(const value of Object.values(sources)){
 const b=await readFile(join(assets,value.path));value.sha256=sha(b);if(value.expected)assert.equal(value.sha256,value.expected);
 const meta=await sharp(b).metadata();value.width=meta.width;value.height=meta.height;value.url='data:image/png;base64,'+b.toString('base64');
}
const base=JSON.parse(await readFile(join(assets,historical+'base.ugoku.json'),'utf8'));
const adopted=JSON.parse(await readFile(join(assets,historical+'adopted.ugoku.json'),'utf8'));
assert.equal(base.document.input.travelMm,25);assert.equal(adopted.document.input.travelMm,30);
assert.equal(adopted.document.revision,3);assert.equal(base.document.designId,adopted.document.designId);
const pdfPath=join(assets,'public/goal011/fish-revision3.pdf');const pdfBytes=await readFile(pdfPath);
assert.equal(sha(pdfBytes),'d9bb14261db7a64365d988b9e11b15d73f8d57a9b2a978d5e180ee254c916e4b');
assert.deepEqual(pdfBytes,await readFile(join(assets,historical+'adopted.pdf')));
const pdf=await PDFDocument.load(pdfBytes);assert.equal(pdf.getPageCount(),5);assert((pdf.getSubject()??'').includes(adopted.document.designHash));
execFileSync('pdftoppm',['-f','1','-l','1','-r','144','-png','-singlefile',pdfPath,join(privateDir,'actual-30mm-pattern')],{stdio:'pipe'});
const rendered=await readFile(join(privateDir,'actual-30mm-pattern.png'));const metadata=await sharp(rendered).metadata();
sources.pattern={path:'private/material-redesign-20261006/images/actual-30mm-pattern.png',sha256:sha(rendered),width:metadata.width,height:metadata.height,url:'data:image/png;base64,'+rendered.toString('base64'),derivedFrom:{path:'public/goal011/fish-revision3.pdf',sha256:sha(pdfBytes),page:1,dpi:144}};
const font=await readFile(join(repo,'apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf'));
const imageDefinitions=[
 {file:'01-from-your-art.png',number:'01',title:'自分の絵から、動く紙工作へ。',footer:'実画面 / 自分の絵を四角で選ぶ',crops:[{source:'selection',rect:[92,170,1416,650],left:118,top:210,scale:1.19}]},
 {file:'02-five-more-millimeters.png',number:'02',title:'あと5mm。紙は増やさない。',footer:'実画面 / 25mmから30mmへ・型紙1枚のまま',crops:[{source:'exact',rect:[32,170,1022,588],left:82,top:276,scale:1.27},{source:'exact',rect:[1078,719,330,434],left:1432,top:377,scale:1.23}]},
 {file:'03-compare-and-choose.png',number:'03',title:'AIが提案。コードが検査。作者が選ぶ。',headingSize:48,caption:'希望と違う案も、比べてから。',footer:'実画面 / 希望70mm・代案35mm',crops:[{source:'alternative',rect:[32,170,1022,588],left:82,top:280,scale:1.27},{source:'alternative',rect:[1078,612,330,552],left:1432,top:288,scale:1.23}]},
 {file:'04-full-size-kit.png',number:'04',title:'採用した設計を、原寸キットに。',footer:'原寸PDF・実画面 / 同じ30mm案・第3版',note:'紙の動作は実物で確認。',crops:[{source:'pattern',rect:[0,0,sources.pattern.width,sources.pattern.height],left:112,top:207,scale:875/sources.pattern.height},{source:'guide',rect:[178,112,1084,111],left:800,top:222,scale:.94,flat:true},{source:'guide',rect:[178,354,1084,75],left:800,top:385,scale:.94,flat:true},{source:'guide',rect:[178,747,1084,405],left:800,top:487,scale:.94},{source:'guide',rect:[178,1171,1084,128],left:800,top:913,scale:.94,flat:true}]},
];
const css=`@font-face{font-family:Zen;src:url(data:font/ttf;base64,${font.toString('base64')})}*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1200px;overflow:hidden;background:#FAFAF7;color:#252923}body{font-family:Zen,sans-serif}.eyebrow{position:absolute;left:84px;top:44px;margin:0;font-size:18px;letter-spacing:.12em;color:#A34A35}.eyebrow span{margin-left:23px;color:#77786F;letter-spacing:.04em;font-size:17px}h1{position:absolute;left:81px;top:86px;margin:0;font-size:52px;line-height:1.4;letter-spacing:.015em;font-weight:600}.caption{position:absolute;left:84px;top:166px;font-size:25px;color:#666C63;margin:0}.crop{position:absolute;overflow:hidden;background:white;border-radius:9px;box-shadow:0 12px 28px #2529230a,0 0 0 1px #DDDCD5}.crop.flat{box-shadow:none;border-radius:0}.crop img{position:absolute;max-width:none;display:block}.footer{position:absolute;left:84px;right:84px;top:1127px;border-top:1px solid #DDDED7;padding-top:18px;display:flex;justify-content:space-between;align-items:center;font-size:20px;color:#6D7268}.footer .note{font-size:20px;color:#6D7268}`;
function crop(c){const s=sources[c.source], [x,y,w,h]=c.rect;assert(x>=0&&y>=0&&x+w<=s.width&&y+h<=s.height,`Crop outside ${c.source}`);assert(c.left+w*c.scale<=1880&&c.top+h*c.scale<=1100);return `<div class="crop${c.flat?' flat':''}" style="left:${c.left}px;top:${c.top}px;width:${w*c.scale}px;height:${h*c.scale}px"><img alt="実画面の抜粋" src="${s.url}" style="left:${-x*c.scale}px;top:${-y*c.scale}px;width:${s.width*c.scale}px;height:${s.height*c.scale}px"></div>`;}
function document(d){return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${escape(d.title)}</title><style>${css}</style><body><p class="eyebrow">${d.number}<span>うごく紙工房</span></p><h1 style="font-size:${d.headingSize??52}px">${escape(d.title)}</h1>${d.caption?`<p class="caption">${escape(d.caption)}</p>`:''}${d.crops.map(crop).join('')}<footer class="footer"><span>${escape(d.footer)}</span><span class="note">${escape(d.note??'')}</span></footer></body></html>`;}
const browser=await chromium.launch({headless:true});const proofs=[];
try{
 const page=await browser.newPage({viewport:{width:1920,height:1200},deviceScaleFactor:1});
 await page.route('**/*',route=>route.abort());
 for(const d of imageDefinitions){const html=document(d);await writeFile(join(privateDir,d.file.replace('.png','.html')),html);await page.setContent(html);await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.decode()));});assert(await page.locator('h1').evaluate(e=>e.getBoundingClientRect().right<1850));await page.screenshot({path:join(outputDir,d.file),animations:'disabled'});const bytes=await readFile(join(outputDir,d.file));proofs.push({...d,width:1920,height:1200,sha256:sha(bytes),bytes:bytes.length});}
 const thumbnails=await Promise.all(imageDefinitions.map(async d=>`<img src="data:image/png;base64,${(await readFile(join(outputDir,d.file))).toString('base64')}" style="width:960px;height:600px;display:block">`));
 await page.setContent(`<html><body style="margin:0;width:1920px;height:1200px;display:grid;grid-template-columns:960px 960px">${thumbnails.join('')}</body></html>`);await page.evaluate(async()=>Promise.all([...document.images].map(img=>img.decode())));await page.screenshot({path:join(privateDir,'contact.png')});
}finally{await browser.close();}
const provenance={format:'ugoku-product-images-review-v2',rendering:'Static HTML/CSS and Chromium. Actual screenshot pixels are CSS cropped and uniformly scaled; no UI text or artwork is reconstructed. Separate excerpts are editorial panels, not a full continuous screenshot.',palette:{background:'#FAFAF7',text:'#252923',accent:'#A34A35'},sources:Object.fromEntries(Object.entries(sources).map(([id,{url:_url,expected:_expected,...source}])=>[id,source])),images:proofs,bindings:{exact:{designId:base.document.designId,baseRevision:2,baseTravelMm:25,candidateRevision:3,candidateTravelMm:30,designHash:adopted.document.designHash,paperSheets:1},alternative:{requestedTravelMm:70,baseTravelMm:28,candidateTravelMm:35,fulfillsRequested:false,source:'Historical actual public C screenshot'},kit:{designId:adopted.document.designId,revision:3,designHash:adopted.document.designHash,travelMm:30,pdfSha256:sha(pdfBytes),physicalValidation:'unverified'}},font:{path:'apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf',sha256:sha(font),license:'SIL OFL 1.1; bundled adjacent OFL.txt'},newModelCalls:0,cloudCalls:0};
await writeFile(join(privateDir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({outputDir,contact:join(privateDir,'contact.png'),images:proofs.map(({file,sha256})=>({file,sha256})),cloudCalls:0,modelCalls:0}));
