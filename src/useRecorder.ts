import { useEffect, useRef, useState } from 'react';
import { MAX_AUDIO_BYTES } from '../functions/src/domain';
import { newEntry, saveLocal, requestDurableStorage, type OutboxEntry } from './outbox';

export function useRecorder(uid: string | null, onSaved: () => void) {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const [recording,setRecording] = useState(false);
  const [starting,setStarting] = useState(false);
  const [seconds,setSeconds] = useState(0);
  const [error,setError] = useState('');
  const [rescue,setRescue] = useState<Blob | null>(null);
  const startedAt = useRef(0);
  const stop = () => { if (recorder.current?.state !== 'inactive') recorder.current?.stop(); };
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now()-startedAt.current)/1000);
      setSeconds(elapsed);
      if (elapsed >= 300) stop();
    },250);
    const hidden = () => { if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange',hidden);
    window.addEventListener('pagehide',stop);
    return () => {clearInterval(timer);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',stop);};
  },[recording]);
  useEffect(() => () => { stop(); stream.current?.getTracks().forEach(t => t.stop()); },[]);
  async function start() {
    if (!uid || starting || recording) return;
    setError('');setRescue(null);setStarting(true);
    let input: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice recording is unavailable here. You can still type or paste your thought.');
      input = await navigator.mediaDevices.getUserMedia({audio:true});
      stream.current = input;
      const preferred = ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
      const media = new MediaRecorder(input, { ...(preferred ? {mimeType:preferred} : {}),audioBitsPerSecond:64000 });
      recorder.current = media;
      const mimeType = media.mimeType.split(';')[0];
      if (!['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(mimeType)) throw new Error('This browser uses an unsupported recording format. Please type your thought.');
      let entry: OutboxEntry = {...newEntry(uid,'voice'),mimeType,phase:'recording'};
      await saveLocal(entry);
      void requestDurableStorage();
      const chunks: Blob[] = [];
      saveChain.current = Promise.resolve();
      media.ondataavailable = event => {
        if (!event.data.size) return;
        chunks.push(event.data);
        const blob = new Blob(chunks,{type:mimeType});
        entry = {...entry,blob,updatedAt:Date.now()};
        const snapshot = {...entry};
        saveChain.current = saveChain.current.then(() => saveLocal(snapshot)).catch(() => {
          setRescue(blob);setError('Device storage is full or unavailable. Download your recording to keep it.');stop();
        });
        if (blob.size > MAX_AUDIO_BYTES - 128000) stop();
      };
      media.onerror = () => {setError('Recording was interrupted. Saving the audio received so far.');stop();};
      input.getTracks().forEach(track => {
        track.onended = stop;
        track.onmute = () => {setError('The microphone was interrupted. Saving your recording.');stop();};
      });
      media.onstop = async () => {
        setRecording(false);
        input?.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks,{type:mimeType});
        await saveChain.current;
        if (!blob.size) {setError('No audio was captured. Please try again.');return;}
        try {
          await saveLocal({...entry,blob,phase:'queued',updatedAt:Date.now()});
          setRescue(null);onSaved();
        } catch {setRescue(blob);setError('Could not save on this device. Download your recording before leaving.');}
      };
      media.start(1000);
      startedAt.current = Date.now();setSeconds(0);setRecording(true);
    } catch (cause) {
      input?.getTracks().forEach(t => t.stop());
      setError((cause as Error).name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser settings, or type your thought.' : (cause as Error).message);
    } finally {setStarting(false);}
  }
  return {recording,starting,seconds,error,rescue,start,stop};
}
