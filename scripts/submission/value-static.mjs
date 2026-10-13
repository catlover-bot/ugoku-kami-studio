/** New public product copy and preserved actual screenshots/PDF. Local files only.
 * --assets-root ABS. Exclusive outputs; never changes the earlier editions.
 */
import assert from 'node:assert/strict';
import {copyFile,constants,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {argumentsFor,hash,read,safeFile,save} from './goal016-media.mjs';

export const EDITION='goal016-value-first';
const ROOT_EDITION='goal016-submission';
const INSTRUCTIONS='private/goal016-value-first/instructions/ugoku-kami-value-first/youtube-description.txt';
const OLD_FOOTER='<text x="54" y="1006" class="label">説明図。Cloud Consoleの実画面ではありません。原寸PDFの取得と、紙の実物動作は別の確認です。</text>';
const exists=path=>access(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});

export function validateCopy(copy){
 assert.equal(copy.schemaVersion,1);assert.equal(copy.edition,EDITION);
 assert.equal(copy.publicAppUrl,'https://ugoku-kami-release-011-erl7e5ym5a-an.a.run.app/');
 assert.deepEqual(copy.images.map(i=>i.role),['selection','request','comparison','print']);
 assert.deepEqual(copy.images.map(i=>i.file),['images/01-select-your-art.png','images/02-describe-the-motion.png','images/03-compare-the-ai-proposal.png','images/04-print-the-adopted-version.png']);
 const strings=[copy.readmeTitle,...Object.values(copy.submissionTextDrafts),...copy.images.map(i=>i.title),...copy.publicReviewNote];
 for(const text of strings){assert(typeof text==='string'&&text.trim());assert(!/未確認|未検証|確認できていません|ローカル|別セッション|収録|実行記録|\d+依頼|\d+送信|追加AI|費用|テスト件数|SHA|Goal|監査|manifest/i.test(text),'Remove production notes from public editorial copy');}
 const counts={};
 for(const [key,text]of Object.entries(copy.submissionTextDrafts)){counts[key]={codePoints:[...text].length,utf16:text.length};assert(counts[key].codePoints<=800&&counts[key].utf16<=800);}
 return counts;
}

export function removeEditorialFooter(svg){
 assert.equal(svg.split(OLD_FOOTER).length,2,'Expected exactly the adopted diagram footer');
 const clean=svg.replace(OLD_FOOTER,'');
 assert.equal(clean.replace('</svg>',OLD_FOOTER+'</svg>'),svg,'Only the final editorial footer may change');
 return clean;
}

export async function main(options){
 const assets=resolve(options['assets-root']),old=join(assets,'public',ROOT_EDITION),out=join(assets,'public',EDITION),work=join(assets,'private',EDITION,'static');
 const copyPath=fileURLToPath(new URL('./value-copy.json',import.meta.url)),copy=await read(copyPath),textCounts=validateCopy(copy);
 const oldManifestPath=await safeFile(old,'manifest.json'),oldManifest=await read(oldManifestPath);assert.equal(oldManifest.edition,ROOT_EDITION);
 const staticFiles=[...copy.images.map(i=>i.file),'adopted-same-version.pdf','architecture.png','problem-solution.txt','architecture-description.txt','review-instructions-public-note.txt','image-descriptions.txt','youtube-description.txt','README.txt'];
 for(const file of staticFiles)assert(!await exists(join(out,file)),'Existing static outputs must be preserved');
 assert(!await exists(work),'Existing static provenance must be preserved');
 const copied=[];
 for(const file of [...copy.images.map(i=>i.file),'adopted-same-version.pdf']){
  const path=await safeFile(old,file),record=oldManifest.files.find(f=>f.file===file);assert(record);assert.equal(await hash(path),record.sha256);
  if(file.endsWith('.png')){const image=oldManifest.images.find(i=>i.file===file);assert(image);assert.equal(image.sha256,record.sha256);copied.push({...record,stamp:image.stamp});}
  else{assert.equal(oldManifest.pdf.pages,5);assert.equal(oldManifest.pdf.revision,2);assert.equal(oldManifest.pdf.sha256,record.sha256);copied.push({...record,stamp:{designId:oldManifest.pdf.designId,revision:oldManifest.pdf.revision,designHash:oldManifest.pdf.designHash}});}
 }
 const oldDiagram=await safeFile(old,'architecture.png');assert.equal(await hash(oldDiagram),oldManifest.architecture.sha256);
 const oldSvgPath=await safeFile(assets,'private/goal016-final/architecture/architecture.svg');
 const oldSvg=await readFile(oldSvgPath,'utf8'),svg=removeEditorialFooter(oldSvg);
 const youtubePath=await safeFile(assets,INSTRUCTIONS),youtubeBytes=await readFile(youtubePath),youtubeText=youtubeBytes.toString('utf8');
 assert(youtubeText.includes('音声：VOICEVOX Nemo（女声1）'));assert(youtubeText.includes(copy.publicAppUrl));
 assert(!/未確認|未検証|ローカル|別セッション|収録|\d+依頼|\d+送信|SHA|Goal|監査/i.test(youtubeText));
 const beforeInputs=await Promise.all([...copied.map(f=>join(old,f.file)),oldManifestPath,oldDiagram,oldSvgPath,youtubePath].map(async path=>({file:relative(assets,path),sha256:await hash(path)})));
 await mkdir(out,{recursive:true});await mkdir(work,{mode:0o700});await mkdir(join(out,'images'),{recursive:true});
 for(const f of copied)await copyFile(join(old,f.file),join(out,f.file),constants.COPYFILE_EXCL);
 let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:1060},deviceScaleFactor:1});
  const errors=[],blocked=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{blocked.push(route.request().url());return route.abort();});
  await page.setContent(`<html><style>body{margin:0}</style>${svg}</html>`);await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('svg').count(),1);assert.equal(await page.locator('svg').getAttribute('viewBox'),'0 0 1600 1060');
  await writeFile(join(out,'architecture.png'),await page.screenshot(),{flag:'wx'});
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 }finally{await browser?.close();}
 await writeFile(join(work,'architecture.svg'),svg,{flag:'wx',mode:0o600});
 const put=(file,text)=>writeFile(join(out,file),text.endsWith('\n')?text:text+'\n',{flag:'wx'});
 await put('problem-solution.txt',copy.submissionTextDrafts.problemSolution);
 await put('architecture-description.txt',copy.submissionTextDrafts.architecture);
 await put('image-descriptions.txt',copy.images.map((image,i)=>`${i+1}. ${image.title}\n${image.file}`).join('\n\n'));
 await put('review-instructions-public-note.txt',['うごく紙工房 — 操作案内','',copy.publicAppUrl,'',...copy.publicReviewNote.map((line,i)=>`${i+1}. ${line}`)].join('\n'));
 await writeFile(join(out,'youtube-description.txt'),youtubeBytes,{flag:'wx'});
 await put('README.txt',[
  copy.readmeTitle,'',
  'YouTubeに投稿する動画：demo-full-narrated.mp4',
  'タイトルと概要欄：youtube-description.txt',
  '字幕：captions.srt　音声原稿：narration-timed.txt','',
  '画像は次の順に掲載してください。',...copy.images.map((image,i)=>`${i+1}. ${image.file} — ${image.title}`),'',
  '課題と解決の説明：problem-solution.txt',
  'アーキテクチャの説明：architecture-description.txt',
  '構成図：architecture.png',
  '型紙と組立ガイド：adopted-same-version.pdf',
  '操作案内：review-instructions-public-note.txt','',
  `公開デモ：${copy.publicAppUrl}`,
  '手動制作はログイン不要です。AIのアクセス方法は審査向け情報をご覧ください。',
  '音声：VOICEVOX Nemo（女声1）',
 ].join('\n'));
 for(const file of beforeInputs)assert.equal(await hash(join(assets,file.file)),file.sha256,'An earlier input changed during preparation');
 const files=await Promise.all(staticFiles.sort().map(async file=>({file,sha256:await hash(join(out,file)),bytes:(await readFile(join(out,file))).length})));
 await save(join(work,'provenance.json'),{format:'ugoku-goal016-value-static-v1',createdAt:new Date().toISOString(),edition:EDITION,copySha256:await hash(copyPath),scriptSha256:await hash(fileURLToPath(import.meta.url)),sourceManifestSha256:await hash(oldManifestPath),copied,architecture:{sourcePngSha256:oldManifest.architecture.sha256,sourceSvgSha256:await hash(oldSvgPath),newSvgSha256:await hash(join(work,'architecture.svg')),sha256:await hash(join(out,'architecture.png')),change:'Only the self-authored editorial footer was removed from the original SVG. All diagram content, positioning, fonts and colours are retained.'},youtubeSourceSha256:await hash(youtubePath),textCounts,oldInputsPreserved:beforeInputs,files,publicManifest:false,cloudCalls:0,newModelCalls:0,appChanges:0});
 console.log(JSON.stringify({status:'static-prepared',edition:EDITION,files:files.length,textCounts,imagesExact:4,pdfExact:true,cloudCalls:0,newModelCalls:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(argumentsFor(process.argv.slice(2),['assets-root']));
