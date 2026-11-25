import {expect,test} from '@playwright/test';
test('opens mobile on capture and desktop on Today; saves a typed thought',async({page,isMobile})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/?demo=1');
  await expect(page.getByText('Example workspace · Explore freely.')).toBeVisible();
  if(isMobile){
    await expect(page.getByRole('heading',{name:'What’s on your mind?'})).toBeVisible();
    await expect(page.getByLabel('Your thought',{exact:true})).toBeInViewport();
    await expect(page.getByRole('button',{name:'Save thought',exact:true})).toBeInViewport();
  }
  else await expect(page.getByRole('heading',{name:'Your thoughts, ready when you are.'})).toBeVisible();
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await page.getByLabel('Your thought',{exact:true}).fill('Keep an idea about a community reading room.');
  await page.getByRole('button',{name:'Save thought',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Added to the example');
  await nav.getByRole('button',{name:'Saved',exact:true}).click();
  await page.getByRole('button',{name:'Originals',exact:true}).click();
  await expect(page.getByText('Example thought · AI processing')).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('a thought gets a follow-up time without becoming a to-do; calendars remain separate',async({page,isMobile})=>{
  await page.goto('/?demo=1');
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await nav.getByRole('button',{name:'Saved',exact:true}).click();
  await page.getByRole('button',{name:'Add something',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('What’s the thought?').fill('A book club for curious neighbors');
  const date=new Date();date.setDate(date.getDate()+2);
  const day=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  await dialog.getByLabel('Date').fill(day);await dialog.getByLabel('Time',{exact:true}).fill('14:00');
  await dialog.getByRole('button',{name:'Save follow-up'}).click();
  await expect(dialog).not.toBeVisible();
  await nav.getByRole('button',{name:'Calendar',exact:true}).click();
  await page.getByLabel('Choose calendar date').fill(day);
  const thoughts=page.getByRole('tabpanel',{name:'Thoughts and to-dos calendar'});
  await expect(thoughts.getByText('A book club for curious neighbors')).toBeVisible();
  await expect(thoughts.getByText('Thought',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Events',exact:true}).click();
  await expect(page.getByRole('tabpanel',{name:'Events calendar'}).getByText('A book club for curious neighbors')).toHaveCount(0);
  await page.getByRole('button',{name:'Add event',exact:true}).click();
  await page.getByRole('dialog').getByLabel('What’s happening?').fill('Dentist');
  await page.getByRole('dialog').getByLabel('Date').fill(day);
  await page.getByRole('dialog').getByLabel('Time',{exact:true}).fill('14:15');
  await page.getByRole('button',{name:'Save event',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('overlaps');
  await page.getByRole('dialog').getByLabel('Time',{exact:true}).fill('15:00');
  await page.getByRole('button',{name:'Save event',exact:true}).click();
  await expect(page.getByRole('tabpanel',{name:'Events calendar'}).getByText('Dentist',{exact:true})).toBeVisible();
});
test('suggestions require approval and original thoughts remain accessible',async({page,isMobile})=>{
  await page.goto('/?demo=1');
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await nav.getByRole('button',{name:'Today',exact:true}).click();
  await page.getByRole('button',{name:'Make time',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Saved to your workspace');
  await nav.getByRole('button',{name:'Saved',exact:true}).click();
  await page.getByRole('button',{name:'Thoughts',exact:true}).click();
  await expect(page.getByRole('button',{name:/What if my best notes became a weekly letter/}).first()).toBeVisible();
  await page.getByRole('button',{name:'Originals',exact:true}).click();
  await expect(page.getByRole('button',{name:'A weekly letter built from things you’re already learning.'})).toBeVisible();
});
test('installed shell can reopen offline',async({page,context,isMobile})=>{
  await page.goto('/?demo=1');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'})).toBeVisible();
  await expect(page.getByText('Offline',{exact:true}).first()).toBeVisible();
  await context.setOffline(false);
});

test('one-tap voice capture saves locally without a review step and survives reopening',async({page,isMobile,context})=>{
  await context.grantPermissions(['microphone']);
  await page.goto('/?demo=1');
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
  await expect(page.getByRole('button',{name:/Save my thought/})).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole('button',{name:/Save my thought/}).click();
  await expect(page.getByRole('status')).toContainText('Recording saved on this device');
  await page.reload();
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await page.locator('.capture-queue summary').click();
  await expect(page.getByText('Saved on this device · waiting to sync',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Download',exact:true})).toBeVisible();
});

test('microphone denial leaves typing available and explains recovery',async({page,isMobile})=>{
  await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};});
  await page.goto('/?demo=1');
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await page.getByRole('button',{name:'Tap to speak',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Microphone permission was denied');
  await expect(page.getByLabel('Your thought',{exact:true})).toBeEnabled();
});

test('the default workspace is empty and personal thoughts appear immediately and survive refresh',async({page,isMobile})=>{
  await page.goto('/');
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await expect(page.getByText('Example workspace · Explore freely.')).toHaveCount(0);
  await expect(page.getByText('A weekly letter built from things you’re already learning.')).toHaveCount(0);
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await page.getByLabel('Your thought',{exact:true}).fill('My own idea for a neighborhood reading room');
  await page.getByRole('button',{name:'Save thought',exact:true}).click();
  await expect(page.locator('.saved-confirmation')).toContainText('My own idea for a neighborhood reading room');
  await expect(page.getByLabel('Your thought',{exact:true})).toHaveValue('');
  await nav.getByRole('button',{name:'Saved',exact:true}).click();
  await expect(page.getByRole('button',{name:'My own idea for a neighborhood reading room',exact:true})).toBeVisible();
  await page.reload();
  await nav.getByRole('button',{name:'Saved',exact:true}).click();
  await expect(page.getByRole('button',{name:'My own idea for a neighborhood reading room',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Follow up on this',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Date').fill('2026-12-03');await dialog.getByLabel('Time',{exact:true}).fill('14:00');
  await dialog.getByRole('button',{name:'Save follow-up'}).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();await nav.getByRole('button',{name:'Calendar',exact:true}).click();
  await page.getByLabel('Choose calendar date').fill('2026-12-03');
  await expect(page.getByRole('tabpanel',{name:'Thoughts and to-dos calendar'}).getByText('My own idea for a neighborhood reading room')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByText('Thought',{exact:true})).toBeVisible();
});

test('a blocked old storage connection never silently loses typed text',async({page,isMobile})=>{
  await page.addInitScript(()=>{
    if(sessionStorage.getItem('held-old-database'))return;
    sessionStorage.setItem('held-old-database','yes');
    const request=indexedDB.open('audiograffiti-outbox',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('captures',{keyPath:'id'});
    request.onsuccess=()=>{(window as Window & {legacyDb?:IDBDatabase}).legacyDb=request.result;};
  });
  await page.goto('/');
  const nav=page.getByRole('navigation',{name:isMobile?'Mobile navigation':'Main navigation'});
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await page.getByLabel('Your thought',{exact:true}).fill('Do not lose this interrupted thought');
  await page.getByRole('button',{name:'Save thought',exact:true}).click();
  await expect(page.getByRole('button',{name:'Reload safely',exact:true})).toBeVisible({timeout:10000});
  await expect(page.getByLabel('Your thought',{exact:true})).toHaveValue('Do not lose this interrupted thought');
  await page.getByRole('button',{name:'Reload safely',exact:true}).click();
  await nav.getByRole('button',{name:'Capture',exact:true}).click();
  await expect(page.getByLabel('Your thought',{exact:true})).toHaveValue('Do not lose this interrupted thought');
  await page.getByRole('button',{name:'Save thought',exact:true}).click();
  await expect(page.locator('.saved-confirmation')).toContainText('Do not lose this interrupted thought');
});
