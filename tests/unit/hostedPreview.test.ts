import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewHandler } from '../../server/http';

let server: Server | undefined;let directory: string;
const password = 'test-preview-password-only';
const authorization = 'Basic '+Buffer.from('preview:'+password).toString('base64');
const publicOrigin = 'https://thoughtsplat-preview.example';
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'thoughtsplat-server-'));
  await writeFile(join(directory,'index.html'),'<title>ThoughtSplat</title>');
  await writeFile(join(directory,'sw.js'),'/* service worker */');
  await writeFile(join(directory,'.env'),'SHOULD_NOT_BE_SERVED=true');
});
afterEach(async()=>{
  if(server){await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}
  for(const file of ['index.html','sw.js','.env'])await unlink(join(directory,file));
  await rmdir(directory);
});
async function start(){
  const transcribe=vi.fn(async()=> 'A thought from my phone.');
  const handler=previewHandler({password,apiKey:'test-key',publicOrigin,distRoot:directory,transcribe});
  server=createServer((req,res)=>{void handler(req,res);});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+(server.address() as AddressInfo).port,transcribe};
}
describe('Render private preview server',()=>{
  it('requires preview authentication for the page and transcription, with a public health check',async()=>{
    const {url,transcribe}=await start();
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url+'/api/local/transcription')).status).toBe(401);
    expect((await fetch(url,{headers:{Authorization:'Basic '+Buffer.from('preview:wrong').toString('base64')}})).status).toBe(401);
    expect(await (await fetch(url+'/healthz')).json()).toEqual({ok:true});
    const page=await fetch(url,{headers:{Authorization:authorization}});
    expect(page.status).toBe(200);expect(await page.text()).toContain('ThoughtSplat');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');expect(transcribe).not.toHaveBeenCalled();
  });
  it('transcribes only authorized same-origin audio and never exposes the key',async()=>{
    const {url,transcribe}=await start();
    const endpoint=url+'/api/local/transcription';
    expect(await (await fetch(endpoint,{headers:{Authorization:authorization}})).json()).toEqual({available:true});
    const headers={Authorization:authorization,'X-ThoughtSplat-Request':'transcribe','Content-Type':'audio/webm',Origin:publicOrigin};
    expect((await fetch(endpoint,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:'audio'})).status).toBe(403);
    expect(transcribe).not.toHaveBeenCalled();
    expect(await (await fetch(endpoint,{method:'POST',headers,body:'audio'})).json()).toEqual({text:'A thought from my phone.'});
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('serves the app shell without exposing dotfiles, source files, or unknown API routes',async()=>{
    const {url}=await start();const headers={Authorization:authorization};
    for(const path of ['/.env','/%2eenv','/server/index.ts','/api/missing','/missing.js','/%2f..%2f.env']){
      expect((await fetch(url+path,{headers})).status).toBe(404);
    }
    const route=await fetch(url+'/calendar',{headers});expect(await route.text()).toContain('ThoughtSplat');
    const worker=await fetch(url+'/sw.js',{headers});expect(worker.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses to start without a strong preview password or a secure hosted origin',()=>{
    expect(()=>previewHandler({password:'',apiKey:'',publicOrigin,distRoot:directory})).toThrow('PREVIEW_PASSWORD');
    expect(()=>previewHandler({password,apiKey:'',publicOrigin:'http://public.example',distRoot:directory})).toThrow('HTTPS');
  });
});
