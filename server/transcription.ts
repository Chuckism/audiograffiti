import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg'];

const endpoint = '/api/local/transcription';
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export type Transcribe = (audio: Buffer, mime: string) => Promise<string>;

// Both adapters keep the API key on the server. The default access policy is
// loopback-only; the hosted adapter must authenticate before invoking this handler.
function localRequestAllowed(request: IncomingMessage) {
  const host = request.headers.host || '';
  return loopback.has(request.socket.remoteAddress || '') && /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)
    && (!request.headers.origin || request.headers.origin === 'http://' + host);
}
export function transcriptionMiddleware(apiKey: string, transcribe: Transcribe = async (audio, mime) => {
  const form = new FormData();
  const extension = mime === 'audio/mp4' ? 'm4a' : mime.split('/')[1];
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'thought.' + extension);
  form.append('model', 'whisper-1');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: form,
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('The transcription key needs updating. Your recording is still saved.');
    if (response.status === 429) throw new Error('Transcription is busy or its API quota is exhausted. Your recording is still saved; try again later.');
    throw new Error('The transcription service could not process this recording. Your audio is still saved.');
  }
  const result = await response.json() as { text?: string };
  if (!result.text?.trim()) throw new Error('No speech was detected. You can listen to the recording or record again.');
  return result.text.trim();
}, authorize: (request: IncomingMessage) => boolean = localRequestAllowed) {
  let activeRequests = 0;
  const jobs = new Map<string, { promise: Promise<string>; createdAt: number }>();
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.url?.split('?')[0] !== endpoint) { next(); return; }
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (!authorize(request)) { reply(403, { error: 'Open the ThoughtSplat preview to transcribe.' }); return; }
    if (request.method === 'GET') { reply(200, { available: Boolean(apiKey) }); return; }
    if (request.method !== 'POST') { reply(405, { error: 'Method not allowed.' }); return; }
    if (request.headers['x-thoughtsplat-request'] !== 'transcribe') { reply(403, { error: 'Open the local preview to transcribe.' }); return; }
    if (!apiKey) { reply(503, { error: 'Transcription is not connected. Your recording is still saved.' }); return; }
    const mime = request.headers['content-type']?.split(';')[0] || '';
    if (!MIME_TYPES.includes(mime)) { reply(415, { error: 'This audio format is not supported.' }); return; }
    if (Number(request.headers['content-length']) > MAX_AUDIO_BYTES) { reply(413, { error: 'Recording is too large.' }); return; }
    if (activeRequests >= 2) { reply(429, { error: 'Transcription is busy. Your recording is saved; try again shortly.' }); return; }
    activeRequests++;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_AUDIO_BYTES) { reply(413, { error: 'Recording is too large.' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      if (!size) { reply(400, { error: 'The recording is empty.' }); return; }
      const audio = Buffer.concat(chunks);
      const key = createHash('sha256').update(mime).update(audio).digest('hex');
      for (const [id, job] of jobs) if (Date.now() - job.createdAt > 300000) jobs.delete(id);
      let job = jobs.get(key);
      if (!job) {
        if (jobs.size >= 30) { reply(429, { error: 'Please wait before transcribing more recordings.' }); return; }
        job = { promise: transcribe(audio, mime), createdAt: Date.now() }; jobs.set(key, job);
        void job.promise.catch(() => jobs.delete(key));
      }
      reply(200, { text: await job.promise });
    } catch (error) {
      reply(502, { error: error instanceof Error ? error.message : 'Transcription failed. Your recording is still saved.' });
    } finally { activeRequests--; }
  };
}
