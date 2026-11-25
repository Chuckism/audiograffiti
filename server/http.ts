import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { transcriptionMiddleware, type Transcribe } from './transcription.js';

interface PreviewOptions {
  password: string; username?: string; apiKey: string; publicOrigin: string;
  distRoot: string; transcribe?: Transcribe;
}
const mimeTypes: Record<string,string> = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml',
  '.png':'image/png','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2'
};
const digest = (value: string) => createHash('sha256').update(value).digest();

export function previewHandler(options: PreviewOptions) {
  if (options.password.length < 16) throw new Error('Set PREVIEW_PASSWORD to at least 16 characters before starting the hosted preview.');
  const origin = new URL(options.publicOrigin).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('The hosted preview requires an HTTPS public origin.');
  const expected = digest((options.username || 'preview') + ':' + options.password);
  const root = resolve(options.distRoot);
  const transcription = transcriptionMiddleware(options.apiKey, options.transcribe, request => !request.headers.origin || request.headers.origin === origin);
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Permissions-Policy','microphone=(self), camera=()');
    response.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    response.setHeader('Cache-Control','no-store');
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200,{'Content-Type':'application/json'});response.end('{"ok":true}');return;
    }
    const authorization = request.headers.authorization || '';
    const credentials = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6),'base64').toString('utf8') : '';
    if (!credentials || !timingSafeEqual(digest(credentials),expected)) {
      response.writeHead(401,{'WWW-Authenticate':'Basic realm="ThoughtSplat private preview", charset="UTF-8"','Content-Type':'text/plain; charset=utf-8'});
      response.end('Sign in with your preview username and password.');return;
    }
    try {
      let next = false;
      await transcription(request,response,()=>{next=true;});
      if (!next) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') {response.writeHead(405);response.end();return;}
      const pathname = decodeURIComponent(new URL(request.url || '/',origin).pathname);
      if (pathname.startsWith('/api/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part=>part.startsWith('.'))) {
        response.writeHead(404);response.end();return;
      }
      let filename = resolve(root,'.'+pathname);
      let rel = relative(root,filename);
      if (rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel)) {response.writeHead(404);response.end();return;}
      let fileStat = await stat(filename).catch(()=>null);
      if (!fileStat?.isFile()) {
        if (extname(pathname)) {response.writeHead(404);response.end();return;}
        filename=resolve(root,'index.html');
        fileStat=await stat(filename);
      }
      const actual = await realpath(filename);
      rel=relative(await realpath(root),actual);
      if (rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel)) {response.writeHead(404);response.end();return;}
      response.setHeader('Content-Type',mimeTypes[extname(filename)] || 'application/octet-stream');
      response.setHeader('Content-Length',fileStat.size);
      if (pathname.startsWith('/assets/')) response.setHeader('Cache-Control','private, max-age=31536000, immutable');
      if (request.method === 'HEAD') {response.end();return;}
      response.end(await readFile(actual));
    } catch {
      if (!response.headersSent) response.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});
      response.end('The preview could not complete this request. Please try again.');
    }
  };
}
