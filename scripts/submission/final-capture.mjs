/** Genuine local manual footage for the Goal014 submission final. No model calls.
 * Run: node scripts/submission/final-capture.mjs --out ABS_DIR --adopted ABS_JSON
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
const REHEARSAL=process.argv.includes('--rehearsal');
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
assert(args.includes('--out')&&args.includes('--adopted'),'Explicit --out and historical --adopted paths required');
const OUT=resolve(value('--out')),ADOPTED=resolve(value('--adopted')),PORT=4874,ORIGIN=`http://127.0.0.1:${PORT}`;
const SOURCE='eb4acf3013df7ed10c91d390e4c4e435026ce7b0';
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
const metadata={rehearsal:REHEARSAL,submissionFootage:!REHEARSAL,kind:'fresh Goal013 UI recording; A deterministic manual dimension assistance25→30, B historical actual Vertex-adopted30mm project imported normally; no new AI',startedAt:new Date().toISOString(),sourceSha:SOURCE,toolingCommit,productSourceMatchesAcceptedMain:true,build:{serverSha256:sha(await readFile(join(ROOT,'dist/server/index.js'))),webIndexSha256:sha(await readFile(join(ROOT,'apps/web/dist/index.html')))},scriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),viewport:{width:1366,height:768},origin:ORIGIN,aiProvider:'none',cloudCalls:0,aiCalls:0,externalRequestsBlocked:[],runRequestsBlocked:[],historicalProject:{path:ADOPTED,sha256:sha(historicalBytes),designId:historical.document.designId,revision:3,designHash:historical.document.designHash,travelMm:30},image:{path:input,sha256:sha(imageBytes)},clips:[],status:'running'};
let browser,server,serverError='',ownServerReady=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ensureServer(){
 assert(!(await fetch(ORIGIN+'/api/health',{signal:AbortSignal.timeout(300)}).then(()=>true).catch(()=>false)),'Port already has a server; do not touch it');
 server=spawn(process.execPath,['dist/server/index.js'],{cwd:ROOT,env:{PATH:process.env.PATH,AI_PROVIDER:'none',AI_PUBLIC_RELEASE:'false',PORT:String(PORT),HOST:'127.0.0.1',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',()=>{});
 server.stderr.on('data',b=>serverError+=b.toString().slice(0,3000));
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Owned local server failed');const response=await fetch(ORIGIN+'/api/status',{signal:AbortSignal.timeout(400)}).catch(()=>null);if(response?.ok){const body=await response.json();assert.equal(body.ai.enabled,false);assert.equal(body.ai.provider,'none');metadata.serverStatus=body;metadata.serverPid=server.pid;ownServerReady=true;return;}await delay(100);}
 throw Error('Owned server did not become ready');
}
async function recording(name,action){
 const directory=join(RUN,name);await mkdir(directory);const context=await browser.newContext({viewport:metadata.viewport,...(REHEARSAL?{}:{recordVideo:{dir:directory,size:metadata.viewport}}),locale:'ja-JP',timezoneId:'Asia/Tokyo',acceptDownloads:true,serviceWorkers:'block'});
 const zero=performance.now(),now=()=>Number(((performance.now()-zero)/1000).toFixed(4));
 const clip={name,directory,wallStartedAt:new Date().toISOString(),events:[],scenes:[],markers:[],screenshots:[],errors:[]};metadata.clips.push(clip);await save(join(RUN,'capture.json'),metadata);
 await context.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(['data:','blob:','about:'].includes(u.protocol)){await route.continue();return;}if(u.origin!==ORIGIN){metadata.externalRequestsBlocked.push({path:u.pathname,method:r.method()});await route.abort('blockedbyclient');return;}if(r.method()==='POST'&&/\/runs(?:\/|$)/.test(u.pathname)){metadata.runRequestsBlocked.push({path:u.pathname,method:r.method()});await route.abort('blockedbyclient');return;}await route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(20000);const raw=REHEARSAL?null:await page.video().path();
 page.on('pageerror',error=>clip.errors.push(error.message));
 const event=(type,data={})=>clip.events.push({type,wallSeconds:now(),...data});
 const hold=seconds=>page.waitForTimeout(seconds*(REHEARSAL?30:1000));
 const marker=async kind=>{const before=now();await page.goto('data:text/html,<meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%;background:%23d600d6}</style>');await hold(.5);const cyanBefore=now();await page.goto('data:text/html,<meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%;background:%2300e5e5}</style>');const cyanAfter=now();await hold(.5);clip.markers.push({kind,wallBefore:before,cyanBefore,cyanAfter,wallEnd:now()});};
 const shot=async name=>{const path=join(directory,name);await page.screenshot({path});clip.screenshots.push({file:name,wallSeconds:now(),sha256:sha(await readFile(path))});};
 const saved=async()=>{await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');const id=await page.locator('main').getAttribute('data-workspace-id');return page.evaluate(id=>new Promise((resolve,reject)=>{const r=indexedDB.open('ugoku-kami.workspaces.v1');r.onerror=()=>reject(Error('IDB unavailable'));r.onsuccess=()=>{const db=r.result,tx=db.transaction('projects'),q=tx.objectStore('projects').get(id);tx.oncomplete=()=>{db.close();resolve(JSON.parse(q.result));};tx.onerror=()=>reject(Error('IDB read'));};}),id);};
 const stamp=async()=>page.locator('main').evaluate(e=>({designId:e.dataset.designId,revision:Number(e.dataset.designRevision),designHash:e.dataset.designHash}));
 const stage=async n=>{await page.locator('.workflow').getByRole('button',{name:new RegExp(['','絵を選ぶ','動きをつける','印刷して作る'][n]+'$')}).click();await page.keyboard.press('Control+Home');event('stage',{stage:n});};
 const flush=async()=>{await page.getByRole('button',{name:'保存・再開',exact:true}).click();await hold(1.2);await page.getByRole('button',{name:'このブラウザに保存',exact:true}).click();await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');await hold(1);await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();};
 const scene=async(id,estimatedSeconds,perform)=>{const start=now();event('scene-start',{id});await shot(id+'-first.png');await perform();const actionEnd=now();// No artificial tail padding: keep actual operations and deliberate reading time.
 await shot(id+'-last.png');clip.scenes.push({id,wallStart:start,wallActionEnd:actionEnd,wallEnd:now(),estimatedSeconds});event('scene-end',{id});await save(join(RUN,'capture.json'),metadata);};
 try{await marker('before');await page.goto(ORIGIN,{waitUntil:'networkidle'});await expect(page.locator('.home-library')).toBeVisible();await shot('first-usable.png');clip.usableWallStart=now();
  await action({page,directory,clip,hold,event,shot,saved,stamp,stage,flush,scene});
  await expect(page.locator('main')).toHaveAttribute('data-save-status','saved');await shot('last-usable.png');clip.usableWallEnd=now();await marker('after');assert.deepEqual(clip.errors,[]);clip.status='passed';
 }catch(error){clip.status='failed';clip.failure={name:error.name,message:error.message};await shot('failure.png').catch(()=>{});throw error;}
 finally{clip.wallFinishedAt=new Date().toISOString();await context.close();clip.rawVideo=raw;clip.rawSha256=raw?sha(await readFile(raw)):null;await save(join(RUN,'capture.json'),metadata);console.log(JSON.stringify({clip:name,status:clip.status,rawVideo:raw,wallBounds:[clip.usableWallStart,clip.usableWallEnd]}));}
}
async function takePdf(page,directory,name,document){
 const d=page.waitForEvent('download',{timeout:90000});await page.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();
 const file=join(directory,name);await(await d).saveAs(file);await chmod(file,0o600);
 const bytes=await readFile(file),pdf=await PDFDocument.load(bytes);
 assert.equal(pdf.getTitle(),`${document.designId} revision ${document.revision}`);assert(pdf.getSubject().includes(document.designHash));assert.equal(pdf.getPageCount(),document.layout.sheets+4);
 for(const p of pdf.getPages()){assert(Math.abs(p.getWidth()-210*72/25.4)<.001);assert(Math.abs(p.getHeight()-297*72/25.4)<.001);}
 return{path:file,sha256:sha(bytes),pages:pdf.getPageCount(),A4:true,designId:document.designId,revision:document.revision,designHash:document.designHash};
}
try{
 await ensureServer();browser=await chromium.launch({headless:true});
 await recording('manual-A',async({page,directory,clip,hold,event,shot,saved,stage,scene})=>{
  await scene('import-and-select',14,async()=>{
   await hold(1);await page.getByRole('button',{name:'自分の絵ではじめる',exact:true}).hover();await hold(.7);
   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'自分の絵ではじめる',exact:true}).click();await(await chooser).setFiles(input);
   const svg=page.locator('#workbench .artwork-svg');await expect(svg.locator(':scope > image').first()).toHaveAttribute('href',/^data:image\/png/);event('own-image-imported');await hold(2);
   await page.getByRole('button',{name:'2点で囲む',exact:true}).click();
   const points=await svg.evaluate(s=>{const image=s.querySelector(':scope > image'),box=image.getBoundingClientRect();return[[350,170],[650,380]].map(([x,y])=>({x:box.x+x/800*box.width,y:box.y+y/550*box.height}));});
   await page.mouse.move(points[0].x,points[0].y,{steps:25});await hold(.6);await page.mouse.click(points[0].x,points[0].y);await hold(.8);await page.mouse.move(points[1].x,points[1].y,{steps:35});await hold(.6);await page.mouse.click(points[1].x,points[1].y);event('actual-two-point-selection');await hold(2.5);
   const project=await saved();assert.deepEqual(project.document.input.selection,{x:350,y:170,width:300,height:210});await shot('selection.png');await save(join(directory,'selected.ugoku.json'),project);clip.selection=project.document.input.selection;
   await page.getByRole('button',{name:'選択の編集を終える',exact:true}).click();await page.getByRole('button',{name:'原画像',exact:true}).click();await hold(1.5);await page.getByRole('button',{name:'正面',exact:true}).click();await hold(.7);
  });
  await scene('25mm-author-conditions',13,async()=>{
   await stage(2);const dimensions=page.locator('.numeric-details');await dimensions.locator(':scope > summary').click();for(const [label,value]of [['作品の幅（mm）','160'],['作品の高さ（mm）','110']]){const size=page.getByLabel(label,{exact:true});await size.fill(value);await size.press('Enter');await hold(.7);}await dimensions.locator(':scope > summary').click();event('author-artwork-size160x110');const field=page.getByLabel('動く距離（mm）',{exact:true});await field.fill('25');await field.press('Enter');await hold(1);
   await page.getByRole('button',{name:'動かす',exact:true}).click();await hold(4);await page.getByRole('button',{name:'動きを停止',exact:true}).click();await page.getByRole('button',{name:'はじめ',exact:true}).click();
   await page.getByLabel('絵の大きさを保つ',{exact:true}).check();await hold(.8);const paper=page.getByLabel('紙の上限（枚）',{exact:true});await paper.fill('1');await paper.press('Enter');await hold(2);
   const project=await saved();assert.equal(project.document.input.travelMm,25);assert.equal(project.document.input.widthMm,160);assert.equal(project.document.input.heightMm,110);assert.equal(project.document.input.maxSheets,1);await save(join(directory,'before-request.ugoku.json'),project);clip.base={designId:project.document.designId,revision:project.document.revision,designHash:project.document.designHash,travelMm:25};await shot('conditions-25mm.png');event('author-conditions-set',clip.base);
  });
  await scene('manual-request-and-comparison',21,async()=>{
   const prompt='あと5mm動かす。絵の大きさは変えない。紙は増やさない';
   const field=page.getByLabel('どう動かしたいですか？',{exact:true});await field.fill('');await field.pressSequentially(prompt,{delay:REHEARSAL?1:45});await hold(5);await shot('manual-request.png');clip.request={text:prompt,method:'deterministic manual dimension assistance; not AI'};
   await page.getByRole('button',{name:'寸法から案をつくる',exact:true}).hover();await hold(.8);await page.getByRole('button',{name:'寸法から案をつくる',exact:true}).click();event('manual-candidate-created');
   const candidate=page.locator('.candidate-workbench');await expect(candidate).toBeVisible();await expect(page.locator('.intent-panel').getByRole('button',{name:'この案にする',exact:true})).toBeVisible();await expect(page.locator('.change-table')).toContainText('30mm');await hold(3);
   await candidate.getByRole('button',{name:'比較を始点にする',exact:true}).click();await hold(1.5);const slider=candidate.getByLabel('候補の比較位置',{exact:true});const box=await slider.boundingBox();await page.mouse.move(box.x+8,box.y+box.height/2,{steps:20});await page.mouse.down();await page.mouse.move(box.x+box.width-8,box.y+box.height/2,{steps:75});await page.mouse.up();await candidate.getByRole('button',{name:'比較を終点にする',exact:true}).click();await hold(2);
   await shot('comparison-25-to-30.png');event('same-scale-comparison-at-end');
   const views=candidate.locator('svg');assert.equal(await views.nth(0).getAttribute('viewBox'),await views.nth(1).getAttribute('viewBox'));clip.candidate={method:'deterministic manual',designHash:await views.nth(1).getAttribute('data-design-hash'),revision:Number(await views.nth(1).getAttribute('data-revision')),travelMm:30,viewBox:await views.nth(1).getAttribute('viewBox')};
   const details=page.locator('.comparison-change-details');if(await details.count()){await details.locator(':scope > summary').click();await hold(2);await details.locator(':scope > summary').click();}
   const preserved=page.locator('.preserved-conditions');await preserved.locator(':scope > summary').click();await preserved.locator('li').last().scrollIntoViewIfNeeded();await hold(4);event('protected-conditions-read');await preserved.locator(':scope > summary').click();
   const checks=page.locator('.candidate-checks');await checks.locator(':scope > summary').click();await checks.locator('li').first().scrollIntoViewIfNeeded();await hold(3);await checks.locator('li').last().scrollIntoViewIfNeeded();await hold(2);event('actual-core-checks-read');await checks.locator(':scope > summary').click();await page.keyboard.press('Control+Home');await hold(2);
  });
  await scene('adopted30mm-motion',7,async()=>{
   await page.locator('.intent-panel').getByRole('button',{name:'この案にする',exact:true}).click();await expect(page.getByLabel('動く距離（mm）',{exact:true})).toHaveValue('30');await page.getByRole('button',{name:'動かす',exact:true}).click();event('adopted30mm-motion-start');await hold(5);await page.getByRole('button',{name:'動きを停止',exact:true}).click();await page.getByRole('button',{name:'おわり',exact:true}).click();await hold(1.5);await shot('opening-motion30.png');
   const project=await saved();await save(join(directory,'adopted.ugoku.json'),project);assert.equal(project.document.input.travelMm,30);assert.equal(project.document.designHash,clip.candidate.designHash);assert.equal(project.document.revision,clip.candidate.revision);assert.equal(project.document.layout.sheets,1);assert.deepEqual(project.records,[]);clip.document={designId:project.document.designId,revision:project.document.revision,designHash:project.document.designHash,travelMm:30};
  });
  await scene('adopted-pdf-and-guide',15,async()=>{
   const project=await saved();await stage(3);await page.getByLabel('PDFに含める内容',{exact:true}).selectOption('all');await hold(3.5);await shot('opening-print30.png');clip.pdf=await takePdf(page,directory,'manual-adopted30mm.pdf',project.document);event('manual-adopted-pdf-downloaded');await hold(2);
   await page.getByRole('button',{name:'組み立てガイドを開く',exact:true}).click();await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash',project.document.designHash);await hold(3);await page.getByRole('button',{name:'次の工程',exact:true}).click();await hold(3.5);await shot('opening-guide30.png');event('manual-guide-step2');
  });
 });
 await recording('kit-B',async({page,directory,clip,hold,event,shot,saved,stamp,stage,flush,scene})=>{
  await scene('import-real-adopted-project',11,async()=>{
   await hold(1);const chooser=page.waitForEvent('filechooser');await page.locator('.home-library').getByRole('button',{name:'ファイルを読み込む',exact:true}).click();await(await chooser).setFiles(ADOPTED);await expect(page.locator('main')).toHaveAttribute('data-design-hash',historical.document.designHash);await expect(page.locator('main')).toHaveAttribute('data-design-revision','3');await stage(2);await hold(2);await page.getByRole('button',{name:'動かす',exact:true}).click();await hold(4);await page.getByRole('button',{name:'動きを停止',exact:true}).click();await page.getByRole('button',{name:'おわり',exact:true}).click();await hold(2);await shot('historical-30mm-loaded.png');event('historical30mmr3-loaded');
  });
  await scene('same-version-print-and-pdf',17,async()=>{
   await stage(3);await hold(3);const mode=page.getByLabel('PDFに含める内容',{exact:true});await mode.selectOption('pattern');await hold(4.5);await mode.selectOption('instructions');await hold(4.5);await mode.selectOption('all');await hold(4.5);await shot('print.png');clip.pdf=await takePdf(page,directory,'same-adopted30mm-r3.pdf',historical.document);event('same-version-pdf-downloaded');await hold(2);await page.locator('.kit-download .field-note').filter({hasText:'最初に50mmの校正線を測ります。'}).hover();await hold(2);
  });
  await scene('guide-real-steps',27,async()=>{
   await page.getByRole('button',{name:'組み立てガイドを開く',exact:true}).click();await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash',historical.document.designHash);await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-revision','3');await hold(3);await page.getByRole('button',{name:'次の工程',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','2');event('guide-step2');await hold(4);await shot('guide-step2.png');await page.locator('.assembly-guide-no-glue').scrollIntoViewIfNeeded();await hold(3);await page.getByRole('button',{name:'次の工程',exact:true}).click();await hold(3);await page.getByRole('button',{name:'次の工程',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','4');event('guide-step4');await hold(4);await page.locator('.assembly-guide-glue').scrollIntoViewIfNeeded();await hold(4);await shot('guide-step4-glue.png');await page.locator('.assembly-guide-no-glue').scrollIntoViewIfNeeded();await hold(3);
   for(const n of [5,6]){await page.getByRole('button',{name:'次の工程',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step',String(n));await page.keyboard.press('Control+Home');await hold(4);event('guide-step'+n);await shot('guide-step'+n+'.png');}
   await page.getByRole('button',{name:'前の工程',exact:true}).click();await page.getByRole('button',{name:'前の工程',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','4');await hold(2);event('guide-return-step4');
  });
  await scene('save-reload-and-guide',17,async()=>{
   await page.getByRole('button',{name:'ガイドを閉じる',exact:true}).click();await flush();const first=await saved();assert.deepEqual(first.document,historical.document);assert.deepEqual(first.records,[]);await save(join(directory,'saved.ugoku.json'),first);event('saved-historical-project-unchanged');await page.reload({waitUntil:'networkidle'});await expect(page.locator('main')).toHaveAttribute('data-design-hash',historical.document.designHash);assert.deepEqual(await saved(),first);await hold(3);await stage(3);await page.getByRole('button',{name:'組み立てガイドを開く',exact:true}).click();await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step','4');await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash',historical.document.designHash);await hold(3);await shot('guide-restored.png');event('same-project-and-guide-restored');await page.locator('.assembly-guide-materials > summary').click();await hold(3);await page.locator('.assembly-guide-materials > summary').click();await page.getByRole('button',{name:'ガイドを閉じる',exact:true}).click();await hold(2);clip.document=await stamp();
  });
 });
 assert.deepEqual(metadata.externalRequestsBlocked,[]);assert.deepEqual(metadata.runRequestsBlocked,[]);metadata.status='passed';
}catch(error){metadata.status='failed';metadata.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{await browser?.close().catch(()=>{});if(server){server.kill('SIGTERM');for(let i=0;i<30&&server.exitCode===null;i++)await delay(100);if(server.exitCode===null){server.kill('SIGKILL');await delay(200);}}metadata.serverStopped=!!server&&server.exitCode!==null;metadata.ownedServerReady=ownServerReady;metadata.serverError=serverError;metadata.finishedAt=new Date().toISOString();await save(join(RUN,'capture.json'),metadata);console.log(JSON.stringify({status:metadata.status,runDirectory:RUN,clips:metadata.clips.map(c=>({name:c.name,status:c.status,rawVideo:c.rawVideo})),serverStopped:metadata.serverStopped,failure:metadata.failure??null}));}
