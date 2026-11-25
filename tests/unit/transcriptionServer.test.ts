import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcriptionMiddleware } from '../../server/localTranscription';

let server: Server;
afterEach(async () => { if(server) await new Promise<void>(resolve => server.close(() => resolve())); });
async function start(key = 'test-only') {
  const transcribe = vi.fn(async () => 'A spoken thought.');
  const middleware = transcriptionMiddleware(key, transcribe);
  server = createServer((req, res) => { void middleware(req, res, () => {res.writeHead(404);res.end();}); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { transcribe, origin, url: origin + '/api/local/transcription' };
}
describe('local transcription endpoint boundaries', () => {
  it('returns capability without the secret and deduplicates audio requests', async () => {
    const { url, origin, transcribe } = await start();
    expect(await (await fetch(url)).json()).toEqual({ available: true });
    const options = { method: 'POST', headers: { 'Content-Type': 'audio/webm', Origin: origin, 'X-ThoughtSplat-Request': 'transcribe' }, body: 'recorded audio' };
    const responses = await Promise.all([fetch(url, options), fetch(url, options)]);
    for(const response of responses) expect(await response.json()).toEqual({ text: 'A spoken thought.' });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin, unmarked, and unsupported requests before calling AI', async () => {
    const { url, origin, transcribe } = await start();
    expect((await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: 'audio' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { Origin: origin }, body: 'audio' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { Origin: origin, 'X-ThoughtSplat-Request': 'transcribe' }, body: 'text' })).status).toBe(415);
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('reports unavailable when no key is configured', async () => {
    const { url, transcribe } = await start('');
    expect(await (await fetch(url)).json()).toEqual({ available: false });
    expect((await fetch(url, { method: 'POST', headers: { 'X-ThoughtSplat-Request': 'transcribe' } })).status).toBe(503);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
