import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/firebase', () => ({ auth: null, db: null, storage: null, functions: null }));
import { DEVICE_OWNER, localEntries, newEntry, removeLocal, saveLocal } from '../../src/outbox';
import { retryDeviceTranscription, transcribeDeviceRecordings } from '../../src/localTranscription';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const voice = () => ({ ...newEntry(DEVICE_OWNER, 'voice'), mimeType: 'audio/webm', blob: new Blob(['spoken thought']) });
beforeEach(async () => {
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('navigator', { onLine: true });
  for (const entry of await localEntries(DEVICE_OWNER)) await removeLocal(entry.id);
});
afterEach(() => vi.unstubAllGlobals());

describe('device recording transcription', () => {
  it('persists the transcript alongside the original audio and does not transcribe twice', async () => {
    const entry = voice(); await saveLocal(entry);
    const request = vi.fn().mockResolvedValueOnce(json({ available: true })).mockResolvedValueOnce(json({ text: 'Keep this as a thought.' }));
    vi.stubGlobal('fetch', request);
    await transcribeDeviceRecordings(); await transcribeDeviceRecordings();
    const [saved] = await localEntries(DEVICE_OWNER);
    expect(saved).toMatchObject({ id: entry.id, source: 'voice', text: 'Keep this as a thought.', transcription: 'ready' });
    expect(await saved.blob!.text()).toBe('spoken thought'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps audio on failure, waits for an explicit retry, and then saves the text', async () => {
    await saveLocal(voice());
    const request = vi.fn().mockResolvedValueOnce(json({ available: true })).mockResolvedValueOnce(json({ error: 'Temporary outage' }, 502));
    vi.stubGlobal('fetch', request); await transcribeDeviceRecordings();
    const [failed] = await localEntries(DEVICE_OWNER);
    expect(failed.transcription).toBe('failed'); expect(failed.blob?.size).toBeGreaterThan(0);
    await transcribeDeviceRecordings(); expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce(json({ available: true })).mockResolvedValueOnce(json({ text: 'Recovered thought' }));
    await retryDeviceTranscription(failed.id);
    expect((await localEntries(DEVICE_OWNER))[0].text).toBe('Recovered thought');
  });
  it('does not resurrect audio discarded while transcription is running', async () => {
    const entry = voice(); await saveLocal(entry);
    let finish!: (response: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(json({ available: true })).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', request); const running = transcribeDeviceRecordings();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await removeLocal(entry.id); finish(json({ text: 'Discarded thought' })); await running;
    expect(await localEntries(DEVICE_OWNER)).toHaveLength(0);
  });
  it('leaves offline and unfinished recordings untouched', async () => {
    const entry = voice(); await saveLocal(entry);
    const request = vi.fn(); vi.stubGlobal('fetch', request); vi.stubGlobal('navigator', { onLine: false });
    await transcribeDeviceRecordings(); expect(request).not.toHaveBeenCalled();
    await saveLocal({ ...entry, phase: 'recording' }); vi.stubGlobal('navigator', { onLine: true });
    await transcribeDeviceRecordings(); expect(request).not.toHaveBeenCalled();
  });
});
