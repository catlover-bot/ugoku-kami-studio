/** Genuine local manual footage for the submission redesign. No model calls.
 * Run: node scripts/submission/redesign-capture.mjs --out ABS_DIR --adopted ABS_JSON
 * Uses a separately built, unmodified application from this worktree only.
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {PDFDocument} from 'pdf-lib';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
assert(args.includes('--out')&&args.includes('--adopted'),'Explicit --out and historical --adopted paths required');
const OUT=resolve(value('--out')),ADOPTED=resolve(value('--adopted')),PORT=4872,ORIGIN=`http://127.0.0.1:${PORT}`;
const SOURCE='a6bf70915f41830b77ef65a44e590e7ef83136b2';
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
const toolingCommit=git('rev-parse','HEAD');
assert.equal(git('diff','--name-only',SOURCE,'--','apps','packages'),'','Product source must match accepted main');
const historicalBytes=await readFile(ADOPTED),historical=JSON.parse(historicalBytes);
assert.equal(sha(historicalBytes),'37f3fa97a214396bc4d3dce5732273bbf322dfde16f2292cbaea2f8ad963ab54');
assert.equal(historical.document.designHash,'5b3d233852f77d3d47610aecb9fbf49a8b61c345b6faa8f0236252850b18fdd8');
assert.equal(historical.document.revision,3);assert.equal(historical.document.input.travelMm,30);assert.deepEqual(historical.records,[]);
await mkdir(OUT,{recursive:true,mode:0o700});
const RUN=join(OUT,new Date().toISOString().replaceAll(':','-'));await mkdir(RUN,{mode:0o700});
const save=async(path,obj)=>writeFile(path,JSON.stringify(obj,null,2)+'\n',{mode:0o600});
const imageBytes=Buffer.from(historical.imageDataUrl.split(',')[1],'base64');const input=join(RUN,'author-fish.png');await writeFile(input,imageBytes,{mode:0o600});
const metadata={kind:'fresh local ordinary UI recording; historical real Vertex adopted project imported normally; no new AI',startedAt:new Date().toISOString(),sourceSha:SOURCE,toolingCommit,productSourceMatchesAcceptedMain:true,build:{serverSha256:sha(await readFile(join(ROOT,'dist/server/index.js'))),webIndexSha256:sha(await readFile(join(ROOT,'apps/web/dist/index.html')))},scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),viewport:{width:1600,height:900},origin:ORIGIN,aiProvider:'none',cloudCalls:0,aiCalls:0,externalRequestsBlocked:[],runRequestsBlocked:[],historicalProject:{path:ADOPTED,sha256:sha(historicalBytes),designId:historical.document.designId,revision:3,designHash:historical.document.designHash,travelMm:30},image:{path:input,sha256:sha(imageBytes)},clips:[],status:'running'};
let browser,server,serverError='',ownServerReady=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ensureServer(){
 assert(!(await fetch(ORIGIN+'/api/health',{signal:AbortSignal.timeout(300)}).then(()=>true).catch(()=>false)),'Port already has a server; do not touch it');
 server=spawn(process.execPath,['dist/server/index.js'],{cwd:ROOT,env:{PATH:process.env.PATH,AI_PROVIDER:'none',AI_PUBLIC_RELEASE:'false',PORT:String(PORT),HOST:'127.0.0.1',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
 server.stderr.on('data',b=>serverError+=b.toString().slice(0,3000));
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Owned local server failed');const response=await fetch(ORIGIN+'/api/status',{signal:AbortSignal.timeout(400)}).catch(()=>null);if(response?.ok){const body=await response.json();assert.equal(body.ai.enabled,false);assert.equal(body.ai.provider,'none');metadata.serverStatus=body;metadata.serverPid=server.pid;ownServerReady=true;return;}await delay(100);}
 throw Error('Owned server did not become ready');
}
async function recording(name,action){
 const directory=join(RUN,name);await mkdir(directory);const context=await browser.newContext({viewport:metadata.viewport,recordVideo:{dir:directory,size:metadata.viewport},locale:'ja-JP',timezoneId:'Asia/Tokyo',acceptDownloads:true,serviceWorkers:'block'});
 const zero=performance.now(),now=()=>Number(((performance.now()-zero)/1000).toFixed(4));
 const clip={name,directory,wallStartedAt:new Date().toISOString(),events:[],scenes:[],markers:[],screenshots:[],errors:[]};metadata.clips.push(clip);await save(join(RUN,'capture.json'),metadata);
 await context.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(['data:','blob:','about:'].includes(u.protocol)){await route.continue();return;}if(u.origin!==ORIGIN){metadata.externalRequestsBlocked.push({path:u.pathname,method:r.method()});await route.abort('blockedbyclient');return;}if(r.method()==='POST'&&/\/runs(?:\/|$)/.test(u.pathname)){metadata.runRequestsBlocked.push({path:u.pathname,method:r.method()});await route.abort('blockedbyclient');return;}await route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(20000);const raw=await page.video().path();
 page.on('pageerror',error=>clip.errors.push(error.message));
 const event=(type,data={})=>clip.events.push({type,wallSeconds:now(),...data});
 const hold=seconds=>page.waitForTimeout(seconds*1000);
 const marker=async kind=>{const before=now();await page.goto('data:text/html,<meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%;background:%23d600d6}</style>');await hold(.5);const cyanBefore=now();await page.goto('data:text/html,<meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%;background:%2300e5e5}</style>');const cyanAfter=now();await hold(.5);clip.markers.push({kind,wallBefore:before,cyanBefore,cyanAfter,wallEnd:now()});};
 const shot=async name=>{const path=join(directory,name);await page.screenshot({path});clip.screenshots.push({file:name,wallSeconds:now(),sha256:sha(await readFile(path))});};
 const saved=async()=>{await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');const id=await page.locator('main').getAttribute('data-workspace-id');return page.evaluate(id=>new Promise((resolve,reject)=>{const r=indexedDB.open('ugoku-kami.workspaces.v1');r.onerror=()=>reject(Error('IDB unavailable'));r.onsuccess=()=>{const db=r.result,tx=db.transaction('projects'),q=tx.objectStore('projects').get(id);tx.oncomplete=()=>{db.close();resolve(JSON.parse(q.result));};tx.onerror=()=>reject(Error('IDB read'));};}),id);};
 const stamp=async()=>page.locator('main').evaluate(e=>({designId:e.dataset.designId,revision:Number(e.dataset.designRevision),designHash:e.dataset.designHash}));
 const stage=async n=>{await page.locator('.workflow').getByRole('button',{name:new RegExp(['','絵を選ぶ','動きをつける','印刷して作る'][n]+'$')}).click();await page.keyboard.press('Control+Home');event('stage',{stage:n});};
 const flush=async()=>{await page.getByRole('button',{name:'保存・再開',exact:true}).click();await hold(1.2);await page.getByRole('button',{name:'このブラウザに保存',exact:true}).click();await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');await hold(1);await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();};
 const scene=async(id,minimumSeconds,perform)=>{const start=now();event('scene-start',{id});await shot(id+'-first.png');await perform();const actionEnd=now();if(actionEnd-start<minimumSeconds)await hold(minimumSeconds-(actionEnd-start));await shot(id+'-last.png');clip.scenes.push({id,wallStart:start,wallActionEnd:actionEnd,wallEnd:now(),minimumSeconds});event('scene-end',{id});await save(join(RUN,'capture.json'),metadata);};
 try{await marker('before');await page.goto(ORIGIN,{waitUntil:'networkidle'});await expect(page.locator('.home-library')).toBeVisible();await shot('first-usable.png');clip.usableWallStart=now();
  await action({page,directory,clip,hold,event,shot,saved,stamp,stage,flush,scene});
  await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');await shot('last-usable.png');clip.usableWallEnd=now();await marker('after');assert.deepEqual(clip.errors,[]);clip.status='passed';
 }catch(error){clip.status='failed';clip.failure={name:error.name,message:error.message};await shot('failure.png').catch(()=>{});throw error;}
 finally{clip.wallFinishedAt=new Date().toISOString();await context.close();clip.rawVideo=raw;clip.rawSha256=sha(await readFile(raw));await save(join(RUN,'capture.json'),metadata);console.log(JSON.stringify({clip:name,status:clip.status,rawVideo:raw,wallBounds:[clip.usableWallStart,clip.usableWallEnd]}));}
}
try{
 await ensureServer();browser=await chromium.launch({headless:true});
 await recording('manual-A',async({page,directory,clip,hold,event,shot,saved,stage,scene})=>{
  await scene('import-and-select',30,async()=>{
   await hold(2);await page.getByRole('button',{name:'自分の絵ではじめる',exact:true}).hover();await hold(1);
   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'自分の絵ではじめる',exact:true}).click();await(await chooser).setFiles(input);await expect(page.locator('.artwork-svg image').first()).toHaveAttribute('href',/^data:image\/png/);event('own-image-imported');await hold(3);
   const edit=page.getByRole('button',{name:'動かす部分を選び直す',exact:true});if(await edit.isVisible())await edit.click();await page.getByRole('button',{name:'2点で囲む',exact:true}).click();
   const points=await page.locator('.artwork-svg').evaluate(svg=>{const art=svg.querySelector('image'),x=Number(art.getAttribute('x')),y=Number(art.getAttribute('y')),w=Number(art.getAttribute('width')),h=Number(art.getAttribute('height')),matrix=svg.getScreenCTM();return[[350,170],[650,380]].map(([px,py])=>{const p=new DOMPoint(x+px/800*w,y+py/550*h).matrixTransform(matrix);return{x:p.x,y:p.y};});});
   await page.mouse.move(points[0].x,points[0].y,{steps:35});await hold(1);await page.mouse.click(points[0].x,points[0].y);await hold(1);await page.mouse.move(points[1].x,points[1].y,{steps:45});await hold(1);await page.mouse.click(points[1].x,points[1].y);event('actual-two-point-selection');await hold(3);
   await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');const project=await saved();assert.deepEqual(project.document.input.selection,{x:350,y:170,width:300,height:210});await shot('selection.png');await save(join(directory,'selected.ugoku.json'),project);clip.selection=project.document.input.selection;
   await page.getByRole('button',{name:'選択の編集を終える',exact:true}).click();await hold(2);await page.getByRole('button',{name:'原画像',exact:true}).click();await hold(2);await page.getByRole('button',{name:'正面',exact:true}).click();
  });
  await scene('motion-front-and-back',30,async()=>{
   await stage(2);const travel=page.getByLabel('動く距離（mm）',{exact:true});await travel.fill('20');await travel.press('Enter');await hold(2);
   await page.getByRole('button',{name:'動かす',exact:true}).click();event('front-playback-start');await hold(5);await page.getByRole('button',{name:'動きを停止',exact:true}).click();
   const slider=page.getByLabel('動きの位置',{exact:true});await slider.scrollIntoViewIfNeeded();const b=await slider.boundingBox();await page.mouse.move(b.x+8,b.y+b.height/2,{steps:20});await page.mouse.down();await page.mouse.move(b.x+b.width-8,b.y+b.height/2,{steps:90});await page.mouse.up();await hold(2);await page.getByRole('button',{name:'はじめ',exact:true}).click();await hold(1);await page.getByRole('button',{name:'おわり',exact:true}).click();await hold(2);event('front-endpoints');
   await page.getByRole('button',{name:'裏のしくみ',exact:true}).click();await hold(2);await page.getByRole('button',{name:'動かす',exact:true}).click();event('back-playback-start');await hold(5);await page.getByRole('button',{name:'動きを停止',exact:true}).click();await page.getByRole('button',{name:'おわり',exact:true}).click();await hold(2);await shot('back-end.png');await page.getByRole('button',{name:'正面',exact:true}).click();await page.getByRole('button',{name:'はじめ',exact:true}).click();await hold(2);
  });
  const project=await saved();await save(join(directory,'manual-final.ugoku.json'),project);clip.document={designId:project.document.designId,revision:project.document.revision,designHash:project.document.designHash,travelMm:project.document.input.travelMm};
 });
 await recording('kit-B',async({page,directory,clip,hold,event,shot,saved,stamp,stage,flush,scene})=>{
  await scene('import-real-adopted-project',8,async()=>{await hold(1);const chooser=page.waitForEvent('filechooser');await page.locator('.home-library').getByRole('button',{name:'ファイルを読み込む',exact:true}).click();await(await chooser).setFiles(ADOPTED);await expect(page.locator('main')).toHaveAttribute('data-design-hash',historical.document.designHash);await expect(page.locator('main')).toHaveAttribute('data-design-revision','3');await stage(2);await page.getByRole('button',{name:'おわり',exact:true}).click();await hold(3);event('historical30mmr3-loaded');});
  await scene('same-version-print-and-pdf',14,async()=>{await stage(3);await hold(3);await shot('print.png');const d=page.waitForEvent('download',{timeout:90000});await page.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();const file=join(directory,'same-adopted30mm-r3.pdf');await(await d).saveAs(file);await chmod(file,0o600);const bytes=await readFile(file),pdf=await PDFDocument.load(bytes);assert.equal(pdf.getTitle(),'goal009-comparison-fish revision 3');assert(pdf.getSubject().includes(historical.document.designHash));assert.equal(pdf.getPageCount(),5);for(const p of pdf.getPages()){assert(Math.abs(p.getWidth()-210*72/25.4)<.001);assert(Math.abs(p.getHeight()-297*72/25.4)<.001);}clip.pdf={path:file,sha256:sha(bytes),pages:5,A4:true,designId:historical.document.designId,revision:3,designHash:historical.document.designHash};event('same-version-pdf-downloaded');await hold(2);await page.locator('.kit-download .field-note').filter({hasText:'最初に50mmの校正線を測ります。'}).hover();await hold(2);});
  await scene('guide-real-steps',24,async()=>{await page.getByRole('button',{name:'組み立てガイドを開く',exact:true}).click();await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash',historical.document.designHash);await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-revision','3');await hold(3);await page.getByRole('button',{name:'次の工程',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','2');event('guide-step2');await hold(5);await shot('guide-step2.png');await page.getByRole('button',{name:'次の工程',exact:true}).click();await hold(3);await page.getByRole('button',{name:'次の工程',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','4');event('guide-step4');await hold(4);await page.locator('.assembly-guide-glue').scrollIntoViewIfNeeded();await hold(3);await shot('guide-step4-glue.png');});
  await scene('save-reload-and-guide',14,async()=>{await page.getByRole('button',{name:'ガイドを閉じる',exact:true}).click();await flush();const first=await saved();assert.deepEqual(first.document,historical.document);assert.deepEqual(first.records,[]);await save(join(directory,'saved.ugoku.json'),first);event('saved-historical-project-unchanged');await page.reload({waitUntil:'networkidle'});await expect(page.locator('main')).toHaveAttribute('data-design-hash',historical.document.designHash);assert.deepEqual(await saved(),first);await hold(2);await stage(3);await page.getByRole('button',{name:'組み立てガイドを開く',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','4');await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash',historical.document.designHash);await hold(2);await shot('guide-restored.png');event('same-project-and-guide-restored');await page.getByRole('button',{name:'ガイドを閉じる',exact:true}).click();await hold(1);clip.document=await stamp();});
 });
 assert.deepEqual(metadata.externalRequestsBlocked,[]);assert.deepEqual(metadata.runRequestsBlocked,[]);metadata.status='passed';
}catch(error){metadata.status='failed';metadata.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{await browser?.close().catch(()=>{});if(server){server.kill('SIGTERM');for(let i=0;i<30&&server.exitCode===null;i++)await delay(100);if(server.exitCode===null)server.kill('SIGKILL');}metadata.serverStopped=!!server&&server.exitCode!==null;metadata.ownedServerReady=ownServerReady;metadata.serverError=serverError;metadata.finishedAt=new Date().toISOString();await save(join(RUN,'capture.json'),metadata);console.log(JSON.stringify({status:metadata.status,runDirectory:RUN,clips:metadata.clips.map(c=>({name:c.name,status:c.status,rawVideo:c.rawVideo})),serverStopped:metadata.serverStopped,failure:metadata.failure??null}));}
