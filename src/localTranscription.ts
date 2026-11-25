import { DEVICE_OWNER, localEntries, updateDeviceCapture } from './outbox';

const endpoint = '/api/local/transcription';
export async function localTranscriptionAvailable() {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    return response.ok && response.headers.get('content-type')?.includes('application/json') && (await response.json()).available === true;
  } catch { return false; }
}

let working = false;
export async function transcribeDeviceRecordings() {
  if (working || !navigator.onLine) return;
  working = true;
  try {
    const pending = (await localEntries(DEVICE_OWNER)).filter(entry => entry.source === 'voice' && entry.phase === 'queued' && !entry.text && entry.blob?.size && entry.transcription !== 'failed');
    if (!pending.length) return;
    if (!await localTranscriptionAvailable()) return;
    for (const candidate of pending) {
      const entry = await updateDeviceCapture(candidate.id, current => {
        if (current.text || current.phase !== 'queued' || current.transcription === 'failed'
          || (current.transcription === 'transcribing' && Date.now() - (current.transcriptionStartedAt || 0) < 120000)) return null;
        return { ...current, transcription: 'transcribing', transcriptionStartedAt: Date.now(), transcriptionError: '' };
      });
      if (!entry) continue;
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': entry.mimeType, 'X-ThoughtSplat-Request': 'transcribe' },
          body: entry.blob, signal: AbortSignal.timeout(100000)
        });
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Transcription is unavailable. Your recording is still saved.');
        const result = await response.json() as { text?: string; error?: string };
        if (!response.ok || !result.text?.trim()) throw new Error(result.error || 'No speech was detected. Your recording is still saved.');
        await updateDeviceCapture(entry.id, current => ({ ...current, text: result.text!.trim(), transcription: 'ready', transcriptionError: '', updatedAt: Date.now() }));
      } catch (error) {
        await updateDeviceCapture(entry.id, current => ({ ...current, transcription: 'failed', transcriptionError: error instanceof Error ? error.message : 'Transcription failed. Your recording is still saved.' }));
      }
    }
  } finally { working = false; }
}

export async function retryDeviceTranscription(id: string) {
  await updateDeviceCapture(id, entry => ({ ...entry, transcription: undefined, transcriptionError: '', transcriptionStartedAt: 0 }));
  await transcribeDeviceRecordings();
}
