'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/* ============================ CONSTANTS ============================ */
const FORMATS = {
  '9:16': { width: 1080, height: 1920, name: 'Vertical (9:16)' },
  '1:1':  { width: 1080, height: 1080,  name: 'Square (1:1)' },
} as const;

type FormatKey = keyof typeof FORMATS;

const FPS = 30;
const MAX_LINES = 3;
const MAX_WORDS_PER_SEGMENT = 18;
const DEFAULT_VOICE = 'nova';
const VOICE_STORAGE_KEY = 'ag:lastVoice';

const PRESETS: Array<[string, string]> = [
  ['#0d1117', '#1f2937'],
  ['#111827', '#2563eb'],
  ['#1f2937', '#10b981'],
  ['#3b0764', '#f43f5e'],
  ['#0f172a', '#9333ea'],
  ['#7c2d12', '#d97706'],
  ['#0c4a6e', '#22d3ee'],
  ['#111827', '#f59e0b'],
  ['#0f172a', '#14b8a6'],
];

// Type declarations
declare global {
  interface Navigator {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
  }
  interface WakeLockSentinel {
    release: () => Promise<void>;
    addEventListener: (type: string, listener: () => void) => void;
  }
}

/* ============================== UTILS ============================== */
function splitWords(s: string) {
  return s.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
}

function coalesceSegments(
  segments: Array<{ start: number; end: number; text: string }>,
  minDur = 0.4
) {
  const out: typeof segments = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    const dur = seg.end - seg.start;
    if (last && last.end - last.start < minDur && dur < minDur) {
      last.text = (last.text + ' ' + seg.text).trim();
      last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** Split long segments into smaller ones based on word count */
function tightenSegments(
  segs: Array<{ start: number; end: number; text: string }>,
  maxWords = MAX_WORDS_PER_SEGMENT
) {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const s of segs) {
    const words = splitWords(s.text);
    if (words.length <= maxWords) {
      out.push(s);
      continue;
    }
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push(words.slice(i, i + maxWords).join(' '));
    }
    const per = (s.end - s.start) / chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      out.push({
        start: s.start + i * per,
        end: s.start + (i + 1) * per,
        text: chunks[i],
      });
    }
  }
  return out;
}

/** Reflow original script across Whisper's segment timings */
function reflowTextOntoTimings(
  segs: Array<{ start: number; end: number; text: string }>,
  originalText: string
) {
  const words = originalText.trim().split(/\s+/).filter(Boolean);
  if (!segs.length || !words.length) return segs;

  const durs = segs.map((s) => Math.max(0, s.end - s.start));
  const total = durs.reduce((a, b) => a + b, 0);
  if (!total) return segs;

  const rawAlloc = durs.map((d) => (d / total) * words.length);
  const counts = rawAlloc.map((a) => Math.floor(a));
  let used = counts.reduce((a, b) => a + b, 0);
  let remaining = words.length - used;

  const order = rawAlloc
    .map((a, i) => ({ i, frac: a - Math.floor(a) }))
    .sort((x, y) => y.frac - x.frac);
  for (let k = 0; k < remaining; k++) counts[order[k % order.length].i]++;

  if (words.length >= segs.length) {
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] === 0) {
        const donor = counts.findIndex((c) => c > 1);
        if (donor >= 0) {
          counts[donor]--;
          counts[i]++;
        }
      }
    }
  }

  const out: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++) {
    const n = Math.max(0, Math.min(words.length - cursor, counts[i] || 0));
    const slice = words.slice(cursor, cursor + n).join(' ');
    cursor += n;
    out.push({ start: segs[i].start, end: segs[i].end, text: slice });
  }
  if (cursor < words.length && out.length) {
    out[out.length - 1].text = [out[out.length - 1].text, ...words.slice(cursor)]
      .filter(Boolean)
      .join(' ');
  }
  return out;
}

/** Normalize for export stability */
function normalizeSegments(
  segs: Array<{ start: number; end: number; text: string }>,
  totalDurGuess?: number
) {
  let out = tightenSegments(coalesceSegments(segs));
  out = out
    .map((s) => ({
      start: Math.max(0, s.start),
      end: Math.max(0, s.end),
      text: (s.text || '').trim(),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // remove overlaps, but do NOT close real gaps (they represent silence)
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
  }

  const last = out[out.length - 1];
  const total =
    Number.isFinite(totalDurGuess!) && totalDurGuess! > 0
      ? totalDurGuess!
      : last?.end ?? 0;
  if (last && total > 0) last.end = Math.max(last.end, total);
  return out;
}

function wrapCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
) {
  const words = (text || '').split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    const m = ctx.measureText(test);
    if (m.width <= maxWidth || !cur) cur = test;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundedRectPath(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}
function roundedRectFill(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  roundedRectPath(g, x, y, w, h, r);
  g.fill();
}

/** Pick a MediaRecorder MIME that the browser supports */
function pickRecorderMime(): string | undefined {
  const cands = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const t of cands) {
    try {
      // @ts-ignore
      if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
    } catch {}
  }
}

/* ---------- gradient helpers ---------- */
function hexToRgb(hex: string) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}
function mixHex(a: string, b: string, t: number) {
  const A = hexToRgb(a),
    B = hexToRgb(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function gradientAtTime(
  t: number,
  dur: number,
  startIdx: number
): [string, string] {
  if (!dur || !isFinite(dur)) return PRESETS[startIdx];
  const total = PRESETS.length;
  const progress = Math.min(Math.max(t / dur, 0), 1) * total;
  const i0 = Math.floor(progress) % total;
  const i1 = (i0 + 1) % total;
  const frac = progress - Math.floor(progress);
  const [a0, a1] = PRESETS[i0];
  const [b0, b1] = PRESETS[i1];
  return [mixHex(a0, b0, frac), mixHex(a1, b1, frac)];
}

/* ---------- image helpers ---------- */
function drawImageCoverRounded(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  dx: number,
  dy: number,
  dW: number,
  dH: number,
  radius = 28,
  opacity = 1
) {
  ctx.save();
  roundedRectPath(ctx, dx, dy, dW, dH, radius);
  ctx.clip();
  // @ts-ignore
  const iW = (img as any).width,
    iH = (img as any).height;
  if (!iW || !iH) {
    ctx.restore();
    return;
  }
  const scale = Math.max(dW / iW, dH / iH);
  const rW = iW * scale,
    rH = iH * scale;
  const x = dx + (dW - rW) / 2;
  const y = dy + (dH - rH) / 2;
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.drawImage(img as any, x, y, rW, rH);
  ctx.restore();
}

/* ---------- TTS segmenting fallback ---------- */
function buildSegmentsFromTextAndDuration(
  text: string,
  durationSec: number,
  targetSegSec = 2.2,
  _minWords = 10,
  maxWords = MAX_WORDS_PER_SEGMENT
) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length)
    return [{ start: 0, end: Math.max(1, durationSec), text: '' }];
  const FIXED_WORDS_PER_SEGMENT = 6; // steady visual rhythm
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += FIXED_WORDS_PER_SEGMENT) {
    chunks.push(words.slice(i, i + FIXED_WORDS_PER_SEGMENT).join(' '));
  }
  const per = durationSec / chunks.length;
  return chunks.map((t, i) => ({
    start: i * per,
    end: (i + 1) * per,
    text: t,
  }));
}

/* ---------- slideshow helper ---------- */
function slideForTime(
  t: number,
  totalDuration: number,
  slides: { img: CanvasImageSource }[]
) {
  if (!slides.length) return null;
  if (!isFinite(totalDuration) || totalDuration <= 0) {
    return slides[0].img;
  }
  const per = totalDuration / slides.length;
  const idx = Math.min(slides.length - 1, Math.floor(t / per));
  return slides[idx]?.img ?? null;
}

/* ---------- gap-aware + perceptual padding caption indexer ---------- */
const EPS = 1e-3; // ~1ms tolerance
function segmentIndexAtTime(
  segs: Array<{ start: number; end: number }>,
  t: number,
  holdGapSec = 0.05,
  leadInSec = 0.03,
  tailOutSec = 0.06
) {
  if (!segs.length) return -1;
  if (!Number.isFinite(t) || t < 0) t = 0;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];

    if (t >= s.start - leadInSec - EPS && t <= s.end + tailOutSec + EPS) return i;

    if (t < s.start - EPS) {
      const prev = i - 1;
      if (prev >= 0) {
        const gap = s.start - segs[prev].end;
        return gap <= holdGapSec + EPS ? prev : -1;
      }
      return -1;
    }
  }

  const last = segs[segs.length - 1];
  const tailGap = t - last.end;
  return tailGap <= holdGapSec + EPS ? segs.length - 1 : -1;
}

/* =========================== COMPONENT ============================ */
export default function Page() {
  /* Format state */
  const [selectedFormat, setSelectedFormat] = useState<FormatKey>('9:16');

  /* Dynamic dimensions */
  const FORMAT = FORMATS[selectedFormat];
  const WIDTH = FORMAT?.width || 1080;
  const HEIGHT = FORMAT?.height || 1920;

  /* Responsive layout */
  const isSquare = WIDTH === HEIGHT;
  const CAP_TOP = isSquare ? HEIGHT - 400 : 1200;
  const CAP_BOTTOM = HEIGHT - 96;
  const CAP_BOX_H = CAP_BOTTOM - CAP_TOP;

  /* Audio + recording */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<BlobPart[]>([]);

  /* Transcript + segments */
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState<
    Array<{ start: number; end: number; text: string }>
  >([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  /* UI */
  const [presetIdx, setPresetIdx] = useState(1);
  const [autoBg, setAutoBg] = useState(true);

  /* User plan */
  const [userPlan, setUserPlan] = useState<'free' | 'pro'>('free');

  /* Export status */
  const [isExporting, setIsExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'render' | 'encode' | 'save'>(
    'idle'
  );
  const [renderPct, setRenderPct] = useState(0);

  /* Export capability detection */
  const [exportSupported, setExportSupported] = useState<boolean | null>(null);
  const [exportReason, setExportReason] = useState<string>('');

  /* Phone preview modal */
  const [phonePreviewOpen, setPhonePreviewOpen] = useState(false);
  const phoneCanvasRef = useRef<HTMLCanvasElement | null>(null);

  /* TTS */
  const [voices] = useState<string[]>([
    'alloy',
    'echo',
    'nova',
    'shimmer',
    'onyx',
    'sage',
    'fable',
    'ash',
    'coral',
  ]);
  const [ttsOpen, setTtsOpen] = useState(true);
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState<string>(DEFAULT_VOICE);
  const [isTtsBusy, setIsTtsBusy] = useState(false);

  /* Artwork (up to 3 images) */
  const [artworks, setArtworks] = useState<
    { url: string; img: CanvasImageSource }[]
  >([]);
  const [artOpacity, setArtOpacity] = useState<number>(1);

  /* Wake lock */
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);

  /* -------- Uniform caption metrics -------- */
  const capMetricsMemoRef = useRef<{ size: number; lineHeight: number } | null>(
    null
  );
  function computeUniformCaptionMetrics(
    ctx: CanvasRenderingContext2D,
    segs: Array<{ text: string }>,
    fallbackText: string
  ) {
    const maxWidth = WIDTH * 0.94;
    const texts: string[] =
      segs?.map((s) => (s.text || '').trim()).filter(Boolean) ?? [];
    if (!texts.length)
      texts.push((fallbackText || '').trim() || 'Record or upload a short');

    const sizeFor = (text: string) => {
      let lo = 56,
        hi = 220,
        best = 56;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const lh = Math.round(mid * 1.14);
        ctx.font = `bold ${mid}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        const lines = wrapCaption(ctx, text, maxWidth);
        const ok =
          lines.length <= MAX_LINES && (lines.length - 1) * lh <= CAP_BOX_H;
        if (ok) {
          best = mid;
          lo = mid + 2;
        } else {
          hi = mid - 2;
        }
      }
      return best;
    };

    let uniform = 220;
    for (const txt of texts) uniform = Math.min(uniform, sizeFor(txt));
    const lineHeight = Math.round(uniform * 1.14);
    return { size: uniform, lineHeight };
  }

  /* ============================ RECORD ============================ */
  const startRecord = async () => {
    try {
      setErr(null);
      recChunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data?.size) recChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(recChunksRef.current, { type: 'audio/webm' });
        setAudioUrl(URL.createObjectURL(blob));
      };
      rec.start();
      setIsRecording(true);
    } catch (e: any) {
      setErr(e?.message || 'Mic permission problem.');
    }
  };
  const stopRecord = () => {
    const rec = mediaRecRef.current;
    try {
      rec?.stop();
      rec?.stream.getTracks().forEach((t) => t.stop());
    } finally {
      mediaRecRef.current = null;
      setIsRecording(false);
    }
  };

  /* ============================ UPLOADS ============================ */
  const onUploadAudio = async (f: File | null) => {
    if (!f) return;
    setErr(null);
    const url = URL.createObjectURL(f);
    setAudioUrl(url);
  };

  async function fileToCanvasImageSource(f: File): Promise<CanvasImageSource> {
    const bmp = await (window as any).createImageBitmap?.(f).catch(() => null);
    if (bmp) return bmp;
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode();
    return img;
  }

  const onUploadArtwork = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setErr(null);

    // Keep native selection order; cap at 3
    let arr = Array.from(files).slice(0, 3);

    // If all files start with a number prefix, sort by that number.
    const leadingNum = (name: string) => {
      const m = name.trim().match(/^(\d{1,4})[\s._-]?/);
      return m ? parseInt(m[1], 10) : NaN;
    };
    const allNumbered = arr.every((f) => !Number.isNaN(leadingNum(f.name)));
    if (allNumbered) {
      arr = arr.sort((a, b) => leadingNum(a.name) - leadingNum(b.name));
    }

    const items: { url: string; img: CanvasImageSource }[] = [];
    for (const f of arr) {
      try {
        const img = await fileToCanvasImageSource(f);
        const url = URL.createObjectURL(f);
        items.push({ url, img });
      } catch {
        // skip bad file
      }
    }
    setArtworks(items);
  };
  const clearArtwork = () => {
    artworks.forEach((a) => URL.revokeObjectURL(a.url));
    setArtworks([]);
  };

  /* ============================ TRANSCRIBE ============================ */
  const transcribe = async () => {
    try {
      setErr(null);
      if (!audioUrl) throw new Error('No audio to transcribe.');
      const res = await fetch(audioUrl);
      const blob = await res.blob();
      const fd = new FormData();
      fd.append(
        'file',
        new File([blob], 'audio.webm', { type: blob.type || 'audio/webm' })
      );
      const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!r.ok) {
        let msg: string;
        try {
          const j = await r.json();
          msg = j?.error || JSON.stringify(j);
        } catch {
          msg = await r.text();
        }
        throw new Error(msg || 'Transcription failed (server error).');
      }
      const data = await r.json();
      const text = (data?.text || '').trim();
      setTranscript(text);

      let segs:
        | Array<{ start: number; end: number; text: string }>
        | undefined =
        (data?.segments as any[])?.map((s: any) => ({
          start: s.start,
          end: s.end,
          text: (s.text || '').trim(),
        })) || [];

      const durGuess = segs[segs.length - 1]?.end ?? 0;
      setSegments(normalizeSegments(segs, durGuess));
      setCurrentIdx(0);
      capMetricsMemoRef.current = null;
    } catch (e: any) {
      setErr(e?.message || 'Transcription failed.');
    }
  };

  /* ============================ TTS ============================ */
 
/* ========================= TTS ============================ */
const generateTTS = async () => {
  try {
    if (!ttsText.trim()) return;
    setIsTtsBusy(true);
    setErr(null);

    // Step 1: Generate TTS audio
    const tt = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: ttsText.trim(),
        voice: ttsVoice,
        format: 'mp3',
      }),
    });
    if (!tt.ok) {
      let msg: string;
      try {
        const j = await tt.json();
        msg = j?.error || JSON.stringify(j);
      } catch {
        msg = await tt.text();
      }
      throw new Error(msg || 'TTS failed (server error).');
    }

    const audioBlob = await tt.blob();
    const url = URL.createObjectURL(audioBlob);
    setAudioUrl(url);
    
    // Probe actual TTS duration
    let dur = 10;
    try {
      const probe = new Audio();
      probe.src = url;
      probe.preload = 'auto';
      await new Promise<void>((res, rej) => {
        probe.addEventListener('loadedmetadata', () => res(), { once: true });
        probe.addEventListener('error', () => rej(new Error('probe failed')), { once: true });
        probe.load();
      });
      if (isFinite(probe.duration) && probe.duration > 0) dur = probe.duration;
    } catch {}
    
    // Step 2: Transcribe the generated TTS audio to get precise timing
    const fd = new FormData();
    fd.append(
      'file',
      new File([audioBlob], 'tts.mp3', { type: audioBlob.type || 'audio/mpeg' })
    );
    
    const transcribeResponse = await fetch('/api/transcribe', { 
      method: 'POST', 
      body: fd 
    });
    
    if (!transcribeResponse.ok) {
      let msg: string;
      try {
        const j = await transcribeResponse.json();
        msg = j?.error || JSON.stringify(j);
      } catch {
        msg = await transcribeResponse.text();
      }
      throw new Error(msg || 'Transcription of TTS failed (server error).');
    }

    const transcribeData = await transcribeResponse.json();

    // Step 3: Use precise Whisper segments, but reflow the original text for accuracy
    let whisperSegs: Array<{ start: number; end: number; text: string }> = 
      (transcribeData?.segments as any[])?.map((s: any) => ({
        start: s.start,
        end: s.end,
        text: (s.text || '').trim(),
      })) || [];

    // Step 4: Reflow the original TTS text onto Whisper's precise timings
    const reflowedSegs = whisperSegs.length > 0 
  ? reflowTextOntoTimings(whisperSegs, ttsText.trim())
  : buildSegmentsFromTextAndDuration(ttsText.trim(), dur); // Use actual duration

  const finalSegs = normalizeSegments(
    reflowedSegs,
    dur
  ); 

    setTranscript(ttsText.trim());
    setSegments(finalSegs);
    setCurrentIdx(0);
    capMetricsMemoRef.current = null;
  } catch (e: any) {
    setErr(e?.message || 'TTS failed.');
  } finally {
    setIsTtsBusy(false);
  }
};
  // Load saved voice on mount (if valid)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VOICE_STORAGE_KEY);
      if (saved && voices.includes(saved)) setTtsVoice(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist whenever selection changes
  useEffect(() => {
    try {
      localStorage.setItem(VOICE_STORAGE_KEY, ttsVoice);
    } catch {}
  }, [ttsVoice]);

  /* ========== FOLLOW PLAYBACK (highlight currentIdx; keep tight) ========== */
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (!segments.length) return;
      const t = a.currentTime;
      const idx = segmentIndexAtTime(segments, t);
      setCurrentIdx((prev) => (idx === -1 ? prev : idx));
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onTime);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('seeked', onTime);
    };
  }, [segments]);

  /* Invalidate caption metrics when text changes */
  useEffect(() => {
    capMetricsMemoRef.current = null;
  }, [segments, transcript, selectedFormat]);

  /* Wake lock management during user playback */
  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator) {
        try {
          const lock = await navigator.wakeLock!.request('screen');
          setWakeLock(lock);
          lock.addEventListener('release', () => setWakeLock(null));
        } catch (e) {
          console.log('Wake lock failed:', e);
        }
      }
    };
    const releaseWakeLock = () => {
      if (wakeLock) {
        wakeLock.release();
        setWakeLock(null);
      }
    };
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => requestWakeLock();
    const onPause = () => releaseWakeLock();
    const onEnded = () => releaseWakeLock();

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      releaseWakeLock();
    };
  }, [audioUrl, wakeLock]);

  /* ================== PREVIEW RELIABILITY FIXES ================== */
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (audioUrl) {
      try {
        if (!a.paused) a.pause();
        a.src = audioUrl;
        a.muted = false;
        a.volume = 1;
        a.load();
      } catch (e) {
        console.warn('audio reload failed:', e);
      }
    }
  }, [audioUrl]);

  // Proactively resume AudioContext on first user gesture
  const pvAcRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    const resume = async () => {
      try {
        await pvAcRef.current?.resume?.();
      } catch {}
    };
    window.addEventListener('click', resume, { once: true, passive: true });
    window.addEventListener('touchstart', resume, { once: true, passive: true });
    return () => {
      window.removeEventListener('click', resume);
      window.removeEventListener('touchstart', resume);
    };
  }, []);

  /* ===================== EXPORT SUPPORT DETECTOR ===================== */
  function detectExportSupport(): { ok: boolean; reason?: string } {
    const hasCanvasCapture =
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof (HTMLCanvasElement.prototype as any).captureStream === 'function';
    const hasMR = typeof window !== 'undefined' && 'MediaRecorder' in window;

    if (!hasCanvasCapture || !hasMR) {
      return { ok: false, reason: 'Missing canvas.captureStream or MediaRecorder.' };
    }

    const isTypeSupported = (window as any).MediaRecorder?.isTypeSupported?.bind(
      (window as any).MediaRecorder
    );
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const webmOk = !!isTypeSupported && candidates.some((c) => isTypeSupported(c));
    if (webmOk) return { ok: true };

    const mp4Ok = !!isTypeSupported && isTypeSupported('video/mp4');
    if (mp4Ok) {
      return {
        ok: false,
        reason:
          'This browser records MP4, but the app expects WebM for export. Use Chrome/Edge/Firefox.',
      };
    }
    return { ok: false, reason: 'MediaRecorder present but no compatible WebM profile.' };
  }

  useEffect(() => {
    const res = detectExportSupport();
    setExportSupported(res.ok);
    setExportReason(res.reason || '');
  }, []);

  /* ============================ DRAW FRAME ============================ */
  function drawFrame(
    ctx: CanvasRenderingContext2D,
    t: number,
    grad: [string, string],
    segs: Array<{ start: number; end: number; text: string }>,
    transcriptText: string,
    bars: number[] | undefined,
    art: CanvasImageSource | null,
    artOp: number,
    plan: 'free' | 'pro'
  ) {
    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    g.addColorStop(0, grad[0]);
    g.addColorStop(1, grad[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Layout
    const left = WIDTH * 0.06,
      right = WIDTH * 0.94;
    const availW = right - left,
      gap = 10;
    const bins = Math.min(64, bars?.length || 64);
    const barW = (availW - (bins - 1) * gap) / bins;

    const maxBarH = isSquare ? 100 : 150;
    const midY = isSquare ? HEIGHT * 0.4 : CAP_TOP - 120;

    // Artwork area
    const artTop = isSquare ? 80 : 120;
    const artBottom = midY - maxBarH / 2 - (isSquare ? 40 : 60);
    const artHeight = Math.max(0, artBottom - artTop);

    if (art && artHeight > 40) {
      drawImageCoverRounded(ctx, art, left, artTop, availW, artHeight, 28, artOp);
    }

    // Waveform
    if (bars?.length) {
      ctx.fillStyle = '#f5c445';
      for (let i = 0; i < bins; i++) {
        const v = Math.max(0.08, Math.min(1, bars[i]));
        const h = v * maxBarH;
        const x = left + i * (barW + gap);
        const y = midY - h / 2;
        roundedRectFill(ctx, x, y, barW, h, 14);
      }
    }

    // Captions
    const idx = segmentIndexAtTime(segs, t);
    const raw =
      idx === -1
        ? '' // real gap → intentionally blank to stay tightly synced
        : (segs[idx]?.text || transcriptText || 'Record or upload audio').trim();

    if (raw) {
      const maxWidth = WIDTH * 0.94;
      if (!capMetricsMemoRef.current) {
        capMetricsMemoRef.current = computeUniformCaptionMetrics(
          ctx,
          segs,
          transcriptText
        );
      }
      const { size: CAP_SIZE, lineHeight: CAP_LH } = capMetricsMemoRef.current!;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${CAP_SIZE}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.fillStyle = '#fff';

      const lines = wrapCaption(ctx, raw, maxWidth).slice(0, MAX_LINES);
      const blockH = (lines.length - 1) * CAP_LH;
      const startY = CAP_TOP + (CAP_BOX_H - blockH) / 2;

      for (let i = 0; i < lines.length; i++) {
        const y = startY + i * CAP_LH;
        ctx.fillText(lines[i], WIDTH / 2, y);
      }
    }

    // Text overlay (free users only)
    if (plan === 'free') {
      ctx.save();
      const displayText = 'AudioGraffiti.co - upgrade to remove the text block';
      const fontSize = Math.round(WIDTH * 0.033); // Scales with canvas width
      ctx.font = `bold ${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';

      const metrics = ctx.measureText(displayText);
      const padX = 20, padY = 12;
      const boxW = metrics.width + padX * 2;
      const boxH = fontSize + padY * 2;

      // Position in upper area (20% down from top)
      const wmX = WIDTH - boxW - 30;
      const wmY = HEIGHT * 0.20;

      // Background
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      roundedRectFill(ctx, wmX, wmY, boxW, boxH, 12);
      
      // Border
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      roundedRectPath(ctx, wmX, wmY, boxW, boxH, 12);
      ctx.stroke();

      // Text
      ctx.fillStyle = '#FFD700';
      ctx.fillText(displayText, wmX + boxW / 2, wmY + boxH / 2);
      ctx.restore();
    }
  }

  /* ========================== LIVE PREVIEW ========================== */
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  // One-time audio graph for preview
  const pvSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const pvAnalyserRef = useRef<AnalyserNode | null>(null);
  const pvFFTRef = useRef<Uint8Array | null>(null);
  const pvConnectedRef = useRef(false);

  // Mirrors for RAF loop
  const segsRef = useRef(segments);
  const transcriptRef = useRef(transcript);
  const presetRef = useRef(presetIdx);
  const autoBgRef = useRef(autoBg);
  const artOpacityRef = useRef(1);
  const artworksRef = useRef(artworks);
  const userPlanRef = useRef(userPlan);

  useEffect(() => { segsRef.current = segments; }, [segments]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { presetRef.current = presetIdx; }, [presetIdx]);
  useEffect(() => { autoBgRef.current = autoBg; }, [autoBg]);
  useEffect(() => { artworksRef.current = artworks; }, [artworks]);
  useEffect(() => { artOpacityRef.current = artOpacity; }, [artOpacity]);
  useEffect(() => { userPlanRef.current = userPlan; }, [userPlan]);

  // Ensure phone canvas pixel size when opened
  useEffect(() => {
    const c = phoneCanvasRef.current;
    if (c) { c.width = WIDTH; c.height = HEIGHT; }
  }, [phonePreviewOpen, WIDTH, HEIGHT]);

  // Preview draw + audio routing
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d')!;

    const a = audioRef.current || undefined;
    if (a) {
      if (!pvAcRef.current) {
        const AC: any =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        pvAcRef.current = new AC();
      }
      if (!pvSrcRef.current) {
        try { pvSrcRef.current = pvAcRef.current!.createMediaElementSource(a); } catch {}
      }
      if (!pvAnalyserRef.current) {
        pvAnalyserRef.current = pvAcRef.current!.createAnalyser();
        pvAnalyserRef.current.fftSize = 1024;           
        pvAnalyserRef.current.smoothingTimeConstant = 0.6; 
        pvFFTRef.current = new Uint8Array(pvAnalyserRef.current.frequencyBinCount);
      }
      // Route analyser to speakers; mute <audio> to avoid double audio
      if (!pvConnectedRef.current && pvSrcRef.current && pvAnalyserRef.current && pvAcRef.current) {
        pvSrcRef.current.connect(pvAnalyserRef.current);
        pvAnalyserRef.current.connect(pvAcRef.current.destination);
        pvConnectedRef.current = true;
        try { if (audioRef.current) audioRef.current.muted = true; } catch {}
      }
    }

    const computeBars = (() => {
      const analyser = pvAnalyserRef.current!;
      const fft = new Uint8Array(analyser.frequencyBinCount);
      const BINS = 64;
      const smooth = new Float32Array(BINS);
      let rollingMax = 0.35;
      const decay = 0.965;

      return () => {
        analyser.getByteFrequencyData(fft);
        const n = fft.length;
        let tickMax = 0;
        const out = new Array(BINS);

        for (let i = 0; i < BINS; i++) {
          const start = Math.floor(Math.pow(i / BINS, 2) * n);
          const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / BINS, 2) * n));

          let sum = 0, c = 0;
          for (let k = start; k < end; k++) { sum += fft[k]; c++; }
          const avg = (sum / Math.max(1, c)) / 255;  
          if (avg > tickMax) tickMax = avg;

          const target = Math.pow(avg, 0.85);
          smooth[i] = smooth[i] * 0.6 + target * 0.4;
          out[i] = smooth[i];
        }

        rollingMax = Math.max(rollingMax * decay, tickMax);

        for (let i = 0; i < BINS; i++) {
          out[i] = out[i] / Math.max(0.18, rollingMax);
          out[i] = Math.min(1, Math.max(0.06, out[i]));
        }
        return out;
      };
    })();

    let raf = 0;
    let fallbackInterval: NodeJS.Timeout | null = null;

    const loop = async () => {
      try {
        const el = audioRef.current;
        const t = el?.currentTime || 0;
        const dur = el?.duration || 1;

        if (pvAcRef.current?.state === 'suspended' && el && !el.paused) {
          try { await pvAcRef.current.resume(); } catch {}
        }

        const grad = (autoBgRef.current
          ? gradientAtTime(t, dur, presetRef.current)
          : PRESETS[presetRef.current]) as [string, string];

        const segs = segsRef.current.length
          ? segsRef.current
          : [{ start: 0, end: 1, text: transcriptRef.current }];

        const b = computeBars();
        const slide = slideForTime(
          t,
          dur,
          artworksRef.current.map((a) => ({ img: a.img }))
        );

        drawFrame(
          ctx, t, grad, segs, transcriptRef.current, b, slide, artOpacityRef.current, userPlanRef.current
        );

        const phoneCtx = phoneCanvasRef.current?.getContext('2d') || null;
        if (phoneCtx) {
          drawFrame(
            phoneCtx, t, grad, segs, transcriptRef.current, b, slide, artOpacityRef.current, userPlanRef.current
          );
        }
      } catch (e) {
        console.error('preview draw error (kept running):', e);
      }

      if (!document.hidden) { raf = requestAnimationFrame(loop); }
    };

    const startFallbackTimer = () => {
      if (!fallbackInterval) { fallbackInterval = setInterval(loop, 250); }
    };
    const stopFallbackTimer = () => {
      if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf); startFallbackTimer();
      } else { stopFallbackTimer(); raf = requestAnimationFrame(loop); }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.hidden) startFallbackTimer();
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      stopFallbackTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [WIDTH, HEIGHT]);

  // Unmute on teardown
  useEffect(() => {
    return () => {
      try { pvSrcRef.current?.disconnect(); } catch {}
      try { pvAnalyserRef.current?.disconnect(); } catch {}
      try { pvAcRef.current?.close(); } catch {}
      if (audioRef.current) audioRef.current.muted = false;
      pvSrcRef.current = null;
      pvAnalyserRef.current = null;
      pvAcRef.current = null;
      pvFFTRef.current = null;
      pvConnectedRef.current = false;
    };
  }, []);

  /* ======================= RENDER → WEBM (export) ======================= */
  async function renderWebMBlob(onProgress?: (p: number) => void): Promise<Blob> {
    if (!audioUrl) throw new Error('No audio.');
    const a = new Audio(audioUrl);
    a.crossOrigin = 'anonymous';
    a.preload = 'auto';
    await new Promise<void>((res) => {
      a.addEventListener('canplay', () => res(), { once: true });
      a.load();
    });

    const totalDuration = a.duration;
    if (!totalDuration || !isFinite(totalDuration)) {
      throw new Error('Could not determine audio duration.');
    }

    const off = document.createElement('canvas');
    off.width = WIDTH;
    off.height = HEIGHT;
    const ctx = off.getContext('2d')!;

    const AC: any =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaElementSource(a);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    const dest = ac.createMediaStreamDestination();
    src.connect(analyser);
    analyser.connect(dest);
    // Do NOT connect to ac.destination here to avoid double audio during export

    const videoStream = (off as HTMLCanvasElement).captureStream(FPS);
    const mixed = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const mime = pickRecorderMime();
    const rec = mime
      ? new MediaRecorder(mixed, { mimeType: mime })
      : new MediaRecorder(mixed);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    const computeBars = (() => {
      const fft = new Uint8Array(analyser.frequencyBinCount);
      const BINS = 64;
      const smooth = new Float32Array(BINS);
      let rollingMax = 0.35;
      const decay = 0.965;

      return () => {
        analyser.getByteFrequencyData(fft);
        const n = fft.length;
        let tickMax = 0;
        const out = new Array(BINS);

        for (let i = 0; i < BINS; i++) {
          const start = Math.floor(Math.pow(i / BINS, 2) * n);
          const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / BINS, 2) * n));

          let sum = 0, c = 0;
          for (let k = start; k < end; k++) { sum += fft[k]; c++; }
          const avg = (sum / Math.max(1, c)) / 255;
          if (avg > tickMax) tickMax = avg;

          const target = Math.pow(avg, 0.85);
          smooth[i] = smooth[i] * 0.6 + target * 0.4;
          out[i] = smooth[i];
        }

        rollingMax = Math.max(rollingMax * decay, tickMax);

        for (let i = 0; i < BINS; i++) {
          out[i] = out[i] / Math.max(0.18, rollingMax);
          out[i] = Math.min(1, Math.max(0.06, out[i]));
        }
        return out;
      };
    })();

    const segs = segments.length
      ? segments
      : [{ start: 0, end: totalDuration, text: transcript || '' }];

    rec.start();
    a.currentTime = 0;
    await ac.resume();
    await a.play();

    // rAF-driven export drawing with hidden-tab fallback
    let raf = 0 as number;
    let fallbackInterval: any = null;

    const tick = () => {
      const currentTime = a.currentTime || 0;

      const b = computeBars();
      const grad = autoBg
        ? (gradientAtTime(currentTime, totalDuration, presetIdx) as [string, string])
        : PRESETS[presetIdx];

      const slide = slideForTime(
        currentTime,
        totalDuration,
        artworks.map((x) => ({ img: x.img }))
      );

      drawFrame(ctx, currentTime, grad, segs, transcript, b, slide, artOpacity, userPlan);

      const progress = Math.min(currentTime / totalDuration, 1);
      onProgress?.(Math.min(99, Math.floor(progress * 99)));

      if (currentTime >= totalDuration) {
        if (fallbackInterval) clearInterval(fallbackInterval);
        cancelAnimationFrame(raf);
        rec.stop();
        return;
      }

      if (!document.hidden) raf = requestAnimationFrame(tick);
    };

    const onVis = () => {
      if (document.hidden) {
        if (!fallbackInterval) fallbackInterval = setInterval(tick, 250);
        cancelAnimationFrame(raf);
      } else {
        if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(tick);

    const webm = await done;

    document.removeEventListener('visibilitychange', onVis);
    onProgress?.(100);
    src.disconnect(); analyser.disconnect(); dest.disconnect(); ac.close();
    if (webm.size < 1024) {
      throw new Error(
        'Captured video is empty/suspiciously small; please record a bit longer and try again.'
      );
    }
    return webm;
  }

  /* ============================ MP4 EXPORT ============================ */
  const exportMP4 = async () => {
    let exportLock: WakeLockSentinel | null = null;
    try {
      if (exportSupported === false) {
        setErr('Export is not supported in this browser. Try desktop Chrome/Edge/Firefox.');
        return;
      }

      try { exportLock = await (navigator as any).wakeLock?.request?.('screen'); } catch {}

      setErr(null);
      setIsExporting(true);
      setPhase('render');
      setRenderPct(0);
      const webm = await renderWebMBlob((p) => setRenderPct(p));
      const fd = new FormData();
      fd.append('file', webm, 'in.webm');
      setPhase('encode');
      const r = await fetch('/api/convert-mp4', { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        let payload: any = null;
        try {
          payload = ct.includes('application/json')
            ? await r.json()
            : { text: await r.text() };
        } catch {
          try { payload = { text: await r.text() }; } catch {}
        }
        const msg =
          payload && payload.stderrTail
            ? `MP4 export failed.\nffmpeg: ${payload.usedBinary || payload.ffmpegPathTried}\n\n${payload.stderrTail}`
            : payload?.error || payload?.text || `HTTP ${r.status} ${r.statusText}`;
        setErr(msg);
        return;
      }
      setPhase('save');
      const mp4 = await r.blob();
      const url = URL.createObjectURL(mp4);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audiograffiti-${FORMAT.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(e?.message || 'MP4 export failed');
    } finally {
      try { await exportLock?.release(); } catch {}
      setIsExporting(false);
      setPhase('idle');
      setRenderPct(0);
      if (audioRef.current && audioUrl) {
        const t = audioRef.current.currentTime || 0;
        audioRef.current.src = audioUrl;
        audioRef.current.currentTime = t;
        audioRef.current.muted = false;
        audioRef.current.volume = 1;
      }
    }
  };

  /* =============================== UI =============================== */
  const currentText = useMemo(
    () => (segments[currentIdx]?.text || transcript || ''),
    [segments, currentIdx, transcript]
  );

  const FormatSelector = () => (
    <div className="mb-3 p-3 rounded-xl bg-black/20 border border-white/10">
      <div className="text-sm opacity-80 mb-2">Aspect Ratio</div>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(FORMATS).map(([key, format]) => (
          <button
            key={key}
            onClick={() => setSelectedFormat(key as FormatKey)}
            className={`px-3 py-2 rounded-md text-sm border transition-colors ${
              selectedFormat === key
                ? 'bg-yellow-500/90 text-black border-yellow-300'
                : 'bg-white/10 hover:bg-white/20 border-white/15'
            }`}
          >
            <div className="font-medium">{format.name}</div>
            <div className="text-xs opacity-70">
              {format.width}×{format.height}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh w-full bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,.9),#000)] text-white flex items-center justify-center p-4">
      <div className="w-[420px] max-w-[92vw] rounded-2xl bg-white/5 backdrop-blur-sm shadow-2xl border border-white/10 p-4">
        {/* header */}
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm opacity-80">AudioGraffiti</div>
          <div className="h-1.5 w-28 rounded-full bg-white/15 overflow-hidden">
            <div className="h-full w-2/3 bg-white/40 rounded-full" />
          </div>
        </div>

        {/* Export support banner */}
        {exportSupported === false && (
          <div className="mb-3 rounded-lg border border-yellow-400/40 bg-yellow-500/10 text-yellow-100 p-3 text-sm">
            <div className="font-medium">Export not supported in this browser.</div>
            <div className="mt-1 opacity-80">
              Please use <b>desktop Chrome, Edge, or Firefox</b> (Android Chrome also works).
            </div>
            {exportReason && <div className="mt-1 opacity-60 text-xs">{exportReason}</div>}
          </div>
        )}

        {/* Aspect ratio selector */}
        <FormatSelector />

        {/* controls */}
        <div className="flex flex-wrap gap-2 mb-3">
          {!isRecording ? (
            <button
              onClick={startRecord}
              className="px-3 py-1.5 rounded-md text-sm bg-green-500/90 hover:bg-green-500 text-black border border-green-300 shadow-sm focus:outline-none focus:ring-2 focus:ring-green-300/60"
            >
              Record
            </button>
          ) : (
            <button
              onClick={stopRecord}
              className="px-3 py-1.5 bg-red-500/90 hover:bg-red-500 rounded-md text-sm text-white"
            >
              Stop
            </button>
          )}

          <label className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm cursor-pointer">
            Upload Audio
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => onUploadAudio(e.target.files?.[0] ?? null)}
            />
          </label>

          <label className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm cursor-pointer">
            Artwork (up to 3 images)
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => onUploadArtwork(e.target.files)}
            />
          </label>

          {artworks.length > 0 && (
            <button
              onClick={clearArtwork}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm"
            >
              Clear Art
            </button>
          )}

          <button
            onClick={transcribe}
            className="px-3 py-1.5 bg-yellow-500/90 hover:bg-yellow-500 rounded-md text-sm ml-auto"
          >
            Transcribe
          </button>
        </div>

        {/* artwork order preview + quick tools */}
        {artworks.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-2">
              {artworks.map((a, i) => (
                <div
                  key={a.url}
                  className="relative h-12 w-12 rounded-md overflow-hidden border border-white/20"
                  title={`Image ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.url}
                    alt={`Artwork ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute -top-1 -left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 border border-white/20">
                    {i + 1}
                  </span>
                </div>
              ))}

              <div className="text-xs opacity-70 ml-2">Order: 1 → 2 → 3</div>

              {/* quick tools */}
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => setArtworks((prev) => [...prev].reverse())}
                  className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 border border-white/15"
                  title="Reverse the order"
                >
                  Reverse
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setArtworks((prev) => (prev.length ? [...prev.slice(1), prev[0]] : prev))
                  }
                  className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 border border-white/15"
                  title="Rotate order (1→2→3 becomes 2→3→1)"
                >
                  Rotate
                </button>
              </div>
            </div>

            <div className="mt-1 text-[11px] opacity-60">
              Tip: Select images in the order you want them to appear. Use <b>Reverse</b> or <b>Rotate</b> to tweak quickly.
              <br />
              <span className="opacity-70">
                Optional: prefix filenames with <b>1-2-3</b> (e.g., "1 cover.jpg", "2 bg.png", "3 logo.png") to enforce that order.
              </span>
            </div>
          </div>
        )}

        {/* TTS composer */}
        <div className="mb-3 rounded-xl border border-white/10 bg-black/20">
          <button
            className="w-full text-left px-3 py-2 text-sm flex items-center justify-between"
            onClick={() => setTtsOpen((o) => !o)}
          >
            <span className="opacity-80">Text → Speech (optional)</span>
            <span className="opacity-60">{ttsOpen ? '−' : '+'}</span>
          </button>
          {ttsOpen && (
            <div className="px-3 pb-3">
              <textarea
                value={ttsText}
                onChange={(e) => setTtsText(e.target.value)}
                rows={3}
                className="w-full rounded-md bg-white/10 border border-white/10 p-2 text-sm"
                placeholder="Type your script here…"
              />
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <div className="flex gap-1 flex-wrap">
                  {voices.map((v) => (
                    <button
                      key={v}
                      onClick={() => setTtsVoice(v)}
                      className={`px-2 py-1 rounded-md text-xs border ${
                        ttsVoice === v
                          ? 'bg-yellow-500/90 text-black border-yellow-300'
                          : 'bg-white/10 hover:bg-white/20 border-white/15'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <button
                  onClick={generateTTS}
                  disabled={isTtsBusy || !ttsText.trim()}
                  className="px-3 py-1.5 rounded-md text-sm bg-green-500/90 hover:bg-green-500 text-black border border-green-300 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-300/60"
                  title={!ttsText.trim() ? 'Type something to enable TTS' : undefined}
                >
                  {isTtsBusy ? 'Generating…' : 'Generate TTS'}
                </button>
                <div className="text-xs opacity-60 ml-auto">
                  {ttsText.trim().length} chars
                </div>
              </div>
              <div className="mt-1 text-[11px] opacity-70">
                Tip: For best timing, prefer simple punctuation; spell out big currency/quantities
                (e.g., "fifty dollars" over "$50"). Years like "1984" are fine.
              </div>
            </div>
          )}
        </div>

        {/* Remove Text Overlay */}
        <div className="mb-3 rounded-xl border border-white/10 bg-black/20">
          <div className="px-3 py-2 text-sm flex items-center justify-between">
            <span className="opacity-80">Remove Text Overlay</span>
            <span className={`px-2 py-1 rounded text-xs ${userPlan === 'pro' ? 'bg-green-500/90 text-black' : 'bg-gray-500/90 text-white'}`}>
              {userPlan === 'pro' ? 'PRO' : 'FREE'}
            </span>
          </div>
          <div className="px-3 pb-3">
            <div className="text-sm opacity-70 mb-2">
              {userPlan === 'free' ? 'Free videos include promotional text overlay' : 'Your videos have clean, professional appearance'}
            </div>
            {userPlan === 'free' && (
              <button 
                onClick={() => setUserPlan('pro')} // Temporary - replace with real upgrade flow
                className="px-3 py-1 bg-yellow-500/90 hover:bg-yellow-500 text-black rounded text-sm"
              >
                Upgrade to Pro - $15/month
              </button>
            )}
          </div>
        </div>

        {/* swatches */}
        <div className="flex gap-2 mb-2">
          {PRESETS.map((g, i) => (
            <button
              key={i}
              onClick={() => setPresetIdx(i)}
              aria-label={`Background ${i + 1}`}
              className={`h-6 w-10 rounded-md border ${
                presetIdx === i ? 'border-white/80' : 'border-white/20'
              }`}
              style={{ background: `linear-gradient(180deg, ${g[0]}, ${g[1]})` }}
            />
          ))}
          <div className="flex items-center gap-2 ml-auto text-xs opacity-80">
            <span>Auto BG</span>
            <button
              onClick={() => setAutoBg((v) => !v)}
              className={`px-2 py-1 rounded ${
                autoBg ? 'bg-yellow-500/90 text-black' : 'bg-white/15 hover:bg-white/25'
              }`}
            >
              {autoBg ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        {/* LIVE PREVIEW */}
        <div
          className="rounded-2xl overflow-hidden border border-white/10"
          style={{ height: '560px' }}
        >
          <canvas
            ref={previewRef}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>

        {/* export row */}
        <div className="mt-3 grid grid-cols-2 gap-2 items-stretch">
          <button
            onClick={exportMP4}
            disabled={isExporting || exportSupported === false}
            className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20 text-sm disabled:opacity-60"
            title={exportSupported === false ? 'Use desktop Chrome/Edge/Firefox for export' : undefined}
          >
            Export MP4
          </button>

          {/* Single Phone Preview button (opens + starts audio) */}
          <button
            type="button"
            onClick={async () => {
              try {
                setPhonePreviewOpen(true);
                await pvAcRef.current?.resume?.();
                const el = audioRef.current;
                if (el) {
                  el.muted = true; // WebAudio path is audible
                  el.volume = 1;
                  if (el.paused) await el.play();
                }
              } catch (e: any) {
                setErr(
                  e?.message ||
                    'Playback was blocked. Click anywhere on the page once, then press Phone Preview again.'
                );
              }
            }}
            className="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-sm border border-white/15"
            title="Open phone-style live preview"
          >
            Phone Preview
          </button>

          <div className="col-span-2 flex items-center justify-end text-xs opacity-70">
            {isExporting
              ? phase === 'render'
                ? `Rendering… ${renderPct}%`
                : phase === 'encode'
                ? 'Encoding…'
                : phase === 'save'
                ? 'Saving…'
                : 'Working…'
              : null}
          </div>
        </div>

        {/* player */}
        <div className="mt-2 p-3 rounded-xl bg-black/20 border border-white/10">
          <audio
            ref={audioRef}
            src={audioUrl || undefined}
            controls
            playsInline
            preload="auto"
            className="w-full"
          />
          <div className="mt-1 flex justify-between text-xs opacity-70">
            <div>Chunks: {Math.max(1, segments.length)}</div>
            <div>
              Current: {segments.length ? `${Math.min(currentIdx + 1, segments.length)}/${segments.length}` : '—'}
            </div>
          </div>
        </div>

        {err && (
          <div className="mt-3 text-sm text-red-300 bg-red-900/30 rounded-md p-2 border border-red-400/30 whitespace-pre-wrap">
            {err}
          </div>
        )}
      </div>

      {/* phone-frame modal */}
      {phonePreviewOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPhonePreviewOpen(false)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            {/* device shell */}
            <div
              className="relative bg-black rounded-[2.5rem] p-5 shadow-2xl border border-white/10"
              style={{ width: '380px' }}
            >
              {/* notch */}
              <div className="absolute top-2 left-1/2 -translate-x-1/2 h-6 w-28 bg-black rounded-b-2xl" />
              {/* screen */}
              <div
                className="rounded-[2rem] overflow-hidden border border-white/10"
                style={{ aspectRatio: `${WIDTH}/${HEIGHT}` }}
              >
                <canvas
                  ref={phoneCanvasRef}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                />
              </div>
            </div>

            {/* close button */}
            <button
              onClick={() => {
                setPhonePreviewOpen(false);
                if (audioRef.current) audioRef.current.muted = false; // restore element audio when closing
              }}
              className="absolute -top-3 -right-3 h-8 w-8 rounded-full bg-white text-black text-sm"
              aria-label="Close phone preview"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}