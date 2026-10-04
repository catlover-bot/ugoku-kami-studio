import {expect, test} from '@playwright/test';
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {manual, stage, startSample, splitPrint} from './helpers';

// Ordinary deterministic app path. No inference client is created by these tests.
test('one request field and review replace normal controls without changing the design before adoption', async ({page}, info) => {
  await page.goto('/'); await startSample(page); await manual(page);
  const base = await page.locator('main').getAttribute('data-design-hash');
  await expect(page.locator('textarea#design-intent')).toHaveCount(1);
  await expect(page.locator('.helper-switch')).toHaveCount(0);
  await page.getByLabel('どう動かしたいですか？').fill('あと5mm動かしたい。絵の大きさと紙の枚数は変えない');
  await page.getByRole('button',{name:'寸法から案をつくる',exact:true}).click();
  await expect(page.locator('.candidate-workbench')).toBeVisible();
  await expect(page.locator('.motion-settings')).toBeHidden();
  await expect(page.locator('#workbench')).toBeHidden();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash',base!);
  const views=page.locator('.candidate-workbench svg');
  expect(await views.nth(0).getAttribute('viewBox')).toBe(await views.nth(1).getAttribute('viewBox'));
  await expect(page.locator('.change-table')).toContainText('25mm');
  await expect(page.locator('.interpretation-details')).not.toHaveAttribute('open','');
  if(info.project.name==='mobile') {
    await page.setViewportSize({width:320,height:844});
    await page.getByRole('button',{name:'いまの作品',exact:true}).click();
    await expect(page.locator('.comparison-before')).toBeVisible(); await expect(page.locator('.comparison-after')).toBeHidden();
    await page.getByRole('button',{name:'候補の作品',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByRole('button',{name:'この案を使わない',exact:true}).click();
  await expect(page.locator('.motion-settings')).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash',base!);
  await manual(page); await page.getByRole('button',{name:'寸法から案をつくる',exact:true}).click();
  await page.getByRole('button',{name:'この案にする',exact:true}).click();
  await expect(page.getByLabel('動く距離（mm）',{exact:true})).toHaveValue('25');
  const adopted=await page.locator('main').getAttribute('data-design-hash');
  await stage(page,3); await splitPrint(page);
  const download=page.waitForEvent('download'); await page.getByRole('button',{name:'型紙だけを保存',exact:true}).click();
  const file=await download;const path=info.outputPath('adopted-pattern.pdf');await file.saveAs(path);
  const pdf=await PDFDocument.load(await readFile(path));expect(pdf.getSubject()).toContain(adopted);expect(pdf.getPages()[0]!.getWidth()).toBeCloseTo(595.276,2);
});

test('local configuration is confined to Settings and no ordinary edit starts inference', async({page})=>{
  let starts=0;
  await page.route('**/api/status',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ai:{enabled:true,provider:'ollama',mode:'ollama',model:'local-test-model',endpoint:'http://127.0.0.1:11434',contextLength:8192,toolMode:'native'},limits:{modelCalls:6,toolCalls:12,timeoutMs:90000,inputBytes:20000,outputTokens:1000}})}));
  await page.route('**/api/sessions/**/runs',route=>{starts++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'provider_unavailable',message:'ローカルAIに接続できません。現在の作品は残っています。'}})});});
  await page.goto('/');await startSample(page);await stage(page,2);
  await expect(page.locator('.connection')).toHaveText('ローカルAI');
  await expect(page.getByText('モデル：local-test-model',{exact:true})).toBeHidden();
  const distance=page.getByLabel('動く距離（mm）',{exact:true});await distance.fill('18');await distance.press('Enter');
  await page.getByRole('button',{name:'動かす',exact:true}).click();await page.getByRole('button',{name:'動きを停止',exact:true}).click();
  await expect(page.locator('main')).toHaveAttribute('data-save-status','saved'); expect(starts).toBe(0);
  await page.getByRole('button',{name:'設定',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'設定',exact:true});await expect(dialog).toContainText('外部の推論APIへ自動で切り替えません');await expect(dialog).toContainText('127.0.0.1:11434');
  await page.getByLabel('AIアクセスコード').fill('synthetic-local-access');await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
  await manual(page);await page.getByRole('button',{name:'AIで案をつくる',exact:true}).click();
  await expect(page.locator('.ai-panel')).toContainText('ローカルAIに接続できません');expect(starts).toBe(1);
  await expect(distance).toHaveValue('18');await expect(page.getByRole('button',{name:'手動の調整に戻る',exact:true})).toBeVisible();
});
