import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const mark = await readFile('public/thoughtsplat-mark.svg','utf8');
const browser = await chromium.launch({channel:'msedge',headless:true});
for (const size of [192,512]) {
  const page = await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
  await page.setContent('<style>body{margin:0;background:#11131b;display:grid;place-items:center;height:100vh}svg{width:72%;height:72%}</style>'+mark);
  await page.screenshot({path:'public/icon-'+size+'.png'});
  await page.close();
}
await browser.close();
