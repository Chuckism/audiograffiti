import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { previewHandler } from './http.js';

const port = Number(process.env.PORT || 10000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid network port.');
const publicOrigin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
if (!publicOrigin) throw new Error('Set PUBLIC_ORIGIN or deploy as a Render web service.');
const handler = previewHandler({
  password:process.env.PREVIEW_PASSWORD || '',username:process.env.PREVIEW_USERNAME || 'preview',
  apiKey:process.env.OPENAI_API_KEY || '',publicOrigin,distRoot:resolve('dist')
});
const server=createServer((request,response)=>{void handler(request,response);});
server.requestTimeout=120000;server.headersTimeout=15000;
server.listen(port,'0.0.0.0',()=>{console.log('ThoughtSplat private preview listening on port '+port);});
process.on('SIGTERM',()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();});
