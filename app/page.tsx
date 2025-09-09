'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/* ============================ CONSTANTS ============================ */
const FORMATS = {
  'linkedin': { width: 1080, height: 1920, name: 'LinkedIn' },
  'stories': { width: 1080, height: 1920, name: 'Stories/Reels' },
  'tiktok': { width: 1080, height: 1920, name: 'TikTok' },
  'instagram-feed': { width: 1080, height: 1080, name: 'Instagram Feed' },
  'substack': { width: 1080, height: 1920, name: 'Substack' },
} as const;

type FormatKey = keyof typeof FORMATS;

const FPS = 30;
const MAX_LINES = 3;
const MAX_WORDS_PER_SEGMENT = 12; // ~10–12 words onscreen

const PRESETS: Array<[string, string]> = [
  ['#0d1117', '#1f2937'], // dark steel
  ['#111827', '#2563eb'], // indigo
  ['#1f2937', '#10b981'], // teal
  ['#3b0764', '#f43f5e'], // magenta→red
  ['#0f172a', '#9333ea'], // purple
  ['#7c2d12', '#d97706'], // amber
  ['#0c4a6e', '#22d3ee'], // cyan
  ['#111827', '#f59e0b'], // gold
  ['#0f172a', '#14b8a6'], // teal 2
];

// Type declarations
declare global {
  interface Navigator {
    wakeLock?: {
      request: (type: 'screen') => Promise<WakeLockSentinel>;
    };
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
    if (last && (last.end - last.start) < minDur && dur < minDur) {
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
    if (words.length <= maxWords) { out.push(s); continue; }
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push(words.slice(i, i + maxWords).join(' '));
    }
    const per = (s.end - s.start) / chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      out.push({ start: s.start + i * per, end: s.start + (i + 1) * per, text: chunks[i] });
    }
  }
  return out;
}

function wrapCaption(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = (text || '').split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    const m = ctx.measureText(test);
    if (m.width <= maxWidth || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundedRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}
function roundedRectFill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function mixHex(a: string, b: string, t: number) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function gradientAtTime(t: number, dur: number, startIdx: number): [string, string] {
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
  dx: number, dy: number, dW: number, dH: number,
  radius = 28,
  opacity = 1
) {
  ctx.save();
  roundedRectPath(ctx, dx, dy, dW, dH, radius);
  ctx.clip();
  // @ts-ignore (browser types provide width/height on concrete image)
  const iW = (img as any).width, iH = (img as any).height;
  if (!iW || !iH) { ctx.restore(); return; }
  const scale = Math.max(dW / iW, dH / iH);
  const rW = iW * scale, rH = iH * scale;
  const x = dx + (dW - rW) / 2;
  const y = dy + (dH - rH) / 2;
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.drawImage(img as any, x, y, rW, rH);
  ctx.restore();
}

/* ---------- TTS segmenting helper ---------- */
function buildSegmentsFromTextAndDuration(
  text: string,
  durationSec: number,
  targetSegSec = 1.6, // Back to 1.6 for stability
  minWords = 5, // Reduced from 8 to allow smaller segments
  maxWords = MAX_WORDS_PER_SEGMENT
) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [{ start: 0, end: Math.max(1, durationSec), text: "" }];
  const segCount = Math.max(1, Math.round(durationSec / targetSegSec));
  const wordsPerSeg = Math.min(maxWords, Math.max(minWords, Math.ceil(words.length / segCount)));
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerSeg) chunks.push(words.slice(i, i + wordsPerSeg).join(" "));
  const per = durationSec / chunks.length;
  return chunks.map((t, i) => ({ start: i * per, end: (i + 1) * per, text: t }));
}

/* =========================== COMPONENT ============================ */
export default function Page() {
  /* Format state */
  const [selectedFormat, setSelectedFormat] = useState<FormatKey>('linkedin');
  
  /* Dynamic dimensions based on selected format */
  const FORMAT = FORMATS[selectedFormat];
  const WIDTH = FORMAT?.width || 1080;
  const HEIGHT = FORMAT?.height || 1920;
  
  /* Responsive layout calculations */
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
  const [segments, setSegments] = useState<Array<{ start: number; end: number; text: string }>>([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  /* UI */
  const [presetIdx, setPresetIdx] = useState(1);
  const [autoBg, setAutoBg] = useState(true);

  /* Export status */
  const [isExporting, setIsExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle'|'render'|'encode'|'save'>('idle');
  const [renderPct, setRenderPct] = useState(0);

  /* TTS */
  const [voices] = useState<string[]>(['alloy','echo','nova','shimmer','onyx','sage','fable','ash','coral']);
  const [ttsOpen, setTtsOpen] = useState(true);
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState<string>('alloy');
  const [isTtsBusy, setIsTtsBusy] = useState(false);

  /* Artwork */
  const [artUrl, setArtUrl] = useState<string>('');
  const [artSource, setArtSource] = useState<CanvasImageSource | null>(null);
  const [artOpacity, setArtOpacity] = useState<number>(1);

  /* Wake lock */
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);

  /* -------- Uniform caption metrics (computed once per transcript) -------- */
  const capMetricsMemoRef = useRef<{ size: number; lineHeight: number } | null>(null);
  function computeUniformCaptionMetrics(
    ctx: CanvasRenderingContext2D,
    segs: Array<{text: string}>,
    fallbackText: string
  ) {
    const maxWidth = WIDTH * 0.94;
    const texts: string[] = (segs?.map(s => (s.text || '').trim()).filter(Boolean) ?? []);
    if (!texts.length) texts.push((fallbackText || '').trim() || 'Record or upload a short');

    const sizeFor = (text: string) => {
      let lo = 56, hi = 220, best = 56;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const lh = Math.round(mid * 1.14);
        ctx.font = `bold ${mid}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        const lines = wrapCaption(ctx, text, maxWidth);
        const ok = lines.length <= MAX_LINES && ((lines.length - 1) * lh) <= CAP_BOX_H;
        if (ok) { best = mid; lo = mid + 2; } else { hi = mid - 2; }
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
      rec.ondataavailable = (e) => { if (e.data?.size) recChunksRef.current.push(e.data); };
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
  const onUploadArtwork = async (f: File | null) => {
    if (!f) return;
    setErr(null);
    const url = URL.createObjectURL(f);
    setArtUrl(url);
    try {
      const bmp = await (window as any).createImageBitmap?.(f);
      if (bmp) { setArtSource(bmp); return; }
      const img = new Image();
      img.src = url;
      await img.decode();
      setArtSource(img);
    } catch {
      setErr('Could not read that image.');
      setArtSource(null);
    }
  };
  const clearArtwork = () => {
    if (artUrl) URL.revokeObjectURL(artUrl);
    setArtUrl(''); setArtSource(null);
  };

  /* ============================ TRANSCRIBE ============================ */
  const transcribe = async () => {
    try {
      setErr(null);
      if (!audioUrl) throw new Error('No audio to transcribe.');
      const res = await fetch(audioUrl);
      const blob = await res.blob();
      const fd = new FormData();
      fd.append('file', new File([blob], 'audio.webm', { type: blob.type || 'audio/webm' }));
      const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!r.ok) {
        let msg: string;
        try { const j = await r.json(); msg = j?.error || JSON.stringify(j); } catch { msg = await r.text(); }
        throw new Error(msg || 'Transcription failed (server error).');
      }
      const data = await r.json();
      const text = (data?.text || '').trim();
      setTranscript(text);

      let segs: Array<{ start: number; end: number; text: string }> =
        (data?.segments as any[])?.map((s: any) => ({ start: s.start, end: s.end, text: (s.text || '').trim() })) || [];

      segs = tightenSegments(coalesceSegments(segs));
      setSegments(segs);
      setCurrentIdx(0);
      capMetricsMemoRef.current = null;
    } catch (e: any) {
      setErr(e?.message || 'Transcription failed.');
    }
  };

  /* ============================ TTS ============================ */
  const generateTTS = async () => {
    try {
      if (!ttsText.trim()) return;
      setIsTtsBusy(true);
      setErr(null);

      const tt = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ttsText.trim(), voice: ttsVoice, format: 'mp3' }),
      });
      if (!tt.ok) {
        let msg: string;
        try { const j = await tt.json(); msg = j?.error || JSON.stringify(j); } catch { msg = await tt.text(); }
        throw new Error(msg || 'TTS failed (server error).');
      }

      const audioBlob = await tt.blob();
      const url = URL.createObjectURL(audioBlob);
      setAudioUrl(url);

      const probe = new Audio(url);
      probe.preload = 'auto';
      await new Promise<void>((res, rej) => {
        const ok = () => res();
        const bad = () => rej(new Error('Could not load TTS audio to measure duration.'));
        probe.addEventListener('canplay', ok, { once: true });
        probe.addEventListener('error', bad, { once: true });
        probe.load();
      });

      const dur = isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 60;
      const segs = tightenSegments(buildSegmentsFromTextAndDuration(ttsText.trim(), dur));
      setTranscript(ttsText.trim());
      setSegments(segs);
      setCurrentIdx(0);
      capMetricsMemoRef.current = null;
    } catch (e: any) {
      setErr(e?.message || 'TTS failed.');
    } finally {
      setIsTtsBusy(false);
    }
  };

  /* ========== FOLLOW PLAYBACK (only to highlight currentIdx) ========== */
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (!segments.length) return;
      const t = a.currentTime;
      let idx = segments.findIndex(s => t >= s.start && t < s.end);
      if (idx === -1) idx = t >= segments[segments.length - 1].end ? segments.length - 1 : 0;
      setCurrentIdx(idx);
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onTime);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('seeked', onTime);
    };
  }, [segments]);

  /* Invalidate caption metrics when text changes */
  useEffect(() => { capMetricsMemoRef.current = null; }, [segments, transcript, selectedFormat]);

  /* Wake lock management */
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

  /* ============================ DRAW FRAME ============================ */
  function drawFrame(
    ctx: CanvasRenderingContext2D,
    t: number,
    grad: [string, string],
    segs: Array<{ start: number; end: number; text: string }>,
    transcriptText: string,
    bars: number[] | undefined,
    art: CanvasImageSource | null,
    artOp: number
  ) {
    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    g.addColorStop(0, grad[0]);
    g.addColorStop(1, grad[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Responsive layout
    const left = WIDTH * 0.06, right = WIDTH * 0.94;
    const availW = right - left, gap = 10;
    const bins = Math.min(64, bars?.length || 64);
    const barW = (availW - (bins - 1) * gap) / bins;
    
    // Adjust layout for square vs portrait
    const maxBarH = isSquare ? 100 : 150;
    const midY = isSquare ? HEIGHT * 0.4 : CAP_TOP - 120;

    // Artwork area (responsive to format)
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

    // Captions (uniform sizing, clean white)
    const maxWidth = WIDTH * 0.94;

    if (!capMetricsMemoRef.current) {
      capMetricsMemoRef.current = computeUniformCaptionMetrics(ctx, segs, transcriptText);
    }
    const { size: CAP_SIZE, lineHeight: CAP_LH } = capMetricsMemoRef.current!;

    let idx = segs.findIndex(s => t >= s.start && t < s.end);
    if (idx === -1) idx = t >= (segs[segs.length - 1]?.end ?? 0) ? segs.length - 1 : 0;
    const raw = (segs[idx]?.text || transcriptText || 'Record or upload audio').trim();

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

  /* ========================== LIVE PREVIEW ========================== */
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  // One-time audio graph for preview
  const pvAcRef = useRef<AudioContext | null>(null);
  const pvSrcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const pvAnalyserRef = useRef<AnalyserNode | null>(null);
  const pvFFTRef = useRef<Uint8Array | null>(null);
  const pvConnectedRef = useRef(false);

  // Live mirrors (avoid stale closures in the RAF loop)
  const segsRef = useRef(segments);
  const transcriptRef = useRef(transcript);
  const presetRef = useRef(presetIdx);
  const autoBgRef = useRef(autoBg);
  const artSrcRef = useRef<CanvasImageSource | null>(null);
  const artOpacityRef = useRef(1);

  useEffect(() => { segsRef.current = segments; }, [segments]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { presetRef.current = presetIdx; }, [presetIdx]);
  useEffect(() => { autoBgRef.current = autoBg; }, [autoBg]);
  useEffect(() => { artSrcRef.current = artSource; }, [artSource]);
  useEffect(() => { artOpacityRef.current = artOpacity; }, [artOpacity]);

  // Enhanced RAF loop with hidden-tab fallback
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d')!;

    const a = audioRef.current || undefined;
    if (a) {
      if (!pvAcRef.current) {
        const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        pvAcRef.current = new AC();
      }
      if (!pvSrcRef.current) {
        try { pvSrcRef.current = pvAcRef.current!.createMediaElementSource(a); } catch {}
      }
      if (!pvAnalyserRef.current) {
        pvAnalyserRef.current = pvAcRef.current!.createAnalyser();
        pvAnalyserRef.current.fftSize = 256;
        pvAnalyserRef.current.smoothingTimeConstant = 0.8;
        pvFFTRef.current = new Uint8Array(pvAnalyserRef.current.frequencyBinCount);
      }
      if (!pvConnectedRef.current && pvSrcRef.current && pvAnalyserRef.current) {
        pvSrcRef.current.connect(pvAnalyserRef.current);
        pvAnalyserRef.current.connect(pvAcRef.current!.destination);
        pvConnectedRef.current = true;
      }
    }

    const computeBars = () => {
      const analyser = pvAnalyserRef.current, fft = pvFFTRef.current;
      const BINS = 64, bars = new Array(BINS).fill(0);
      if (!analyser || !fft) return bars;
      analyser.getByteFrequencyData(fft);
      for (let i = 0; i < BINS; i++) {
        const start = Math.floor((i / BINS) * fft.length);
        const end = Math.floor(((i + 1) / BINS) * fft.length);
        let sum = 0, n = 0;
        for (let k = start; k < end; k++) { sum += fft[k]; n++; }
        bars[i] = (sum / Math.max(1, n)) / 255;
      }
      return bars;
    };

    let raf = 0;
    let fallbackInterval: NodeJS.Timeout | null = null;
    let lastDraw = performance.now();

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

        const bars = computeBars();

        drawFrame(
          ctx,
          t,
          grad,
          segs,
          transcriptRef.current,
          bars,
          artSrcRef.current,
          artOpacityRef.current
        );

        lastDraw = performance.now();
      } catch (e) {
        console.error('preview draw error (kept running):', e);
      }
      
      // Use RAF when visible, fallback interval when hidden
      if (!document.hidden) {
        raf = requestAnimationFrame(loop);
      }
    };

    // Hidden tab fallback (4fps when page hidden)
    const startFallbackTimer = () => {
      if (!fallbackInterval) {
        fallbackInterval = setInterval(loop, 250); // 4fps
      }
    };

    const stopFallbackTimer = () => {
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        startFallbackTimer();
      } else {
        stopFallbackTimer();
        raf = requestAnimationFrame(loop);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    
    // Start the appropriate loop
    if (document.hidden) {
      startFallbackTimer();
    } else {
      raf = requestAnimationFrame(loop);
    }

    const watchdog = setInterval(() => {
      const el = audioRef.current;
      const playing = !!el && !el.paused && !el.ended;
      if (playing && performance.now() - lastDraw > 1000) {
        try { pvAcRef.current?.resume(); } catch {}
      }
    }, 1000);

    return () => {
      cancelAnimationFrame(raf);
      stopFallbackTimer();
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [WIDTH, HEIGHT]);

  // Cleanup AC on unmount
  useEffect(() => {
    return () => {
      try { pvSrcRef.current?.disconnect(); } catch {}
      try { pvAnalyserRef.current?.disconnect(); } catch {}
      try { pvAcRef.current?.close(); } catch {}
      pvSrcRef.current = null; pvAnalyserRef.current = null; pvAcRef.current = null;
      pvFFTRef.current = null; pvConnectedRef.current = false;
    };
  }, []);

  /* ======================= RENDER → WEBM (export) ======================= */
  async function renderWebMBlob(onProgress?: (p: number) => void): Promise<Blob> {
    if (!audioUrl) throw new Error('No audio.');
    const a = new Audio(audioUrl);
    a.crossOrigin = 'anonymous'; a.preload = 'auto';
    await new Promise<void>((res) => { a.addEventListener('canplay', () => res(), { once: true }); a.load(); });

    const totalDuration = a.duration;
    if (!totalDuration || !isFinite(totalDuration)) {
      throw new Error('Could not determine audio duration.');
    }

    const off = document.createElement('canvas'); off.width = WIDTH; off.height = HEIGHT;
    const ctx = off.getContext('2d')!;

    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaElementSource(a);
    const analyser = ac.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.8;
    const dest = ac.createMediaStreamDestination();
    src.connect(analyser); analyser.connect(dest); src.connect(ac.destination);

    const videoStream = off.captureStream(FPS);
    const mixed = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickRecorderMime();
    const rec = mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });

    const fft = new Uint8Array(analyser.frequencyBinCount);
    const BINS = 64, bars = new Array(BINS).fill(0);
    const computeBars = () => {
      analyser.getByteFrequencyData(fft);
      for (let i = 0; i < BINS; i++) {
        const start = Math.floor((i / BINS) * fft.length);
        const end = Math.floor(((i + 1) / BINS) * fft.length);
        let sum = 0, n = 0;
        for (let k = start; k < end; k++) { sum += fft[k]; n++; }
        bars[i] = (sum / Math.max(1, n)) / 255;
      }
      return bars;
    };

    const segs = segments.length ? segments : [{ start: 0, end: totalDuration, text: transcript || '' }];

    rec.start(); 
    a.currentTime = 0; 
    a.play(); 
    if (ac.state === 'suspended') await ac.resume();

    // Create a reliable timer independent of audio playback
    const startTime = Date.now();
    let raf = 0;
    
    const tick = () => {
      // Use elapsed real time instead of audio.currentTime
      const elapsedMs = Date.now() - startTime;
      const currentTime = elapsedMs / 1000; // Convert to seconds
      
      // Slow down caption timing slightly to prevent drift ahead of audio
      const captionTime = currentTime * 0.98; // 2% slower than real time
      
      const b = computeBars();
      const grad = autoBg ? gradientAtTime(currentTime, totalDuration, presetIdx) : PRESETS[presetIdx];
      drawFrame(ctx, captionTime, grad as [string, string], segs, transcript, b, artSource, artOpacity);
      
      const progress = Math.min(currentTime / totalDuration, 1);
      onProgress?.(Math.min(99, Math.floor(progress * 99)));
      
      // Continue until we reach the full duration
      if (currentTime < totalDuration) {
        raf = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(raf);
        rec.stop();
      }
    };
    tick();

    const webm = await done; onProgress?.(100);
    if (webm.size < 1024) { src.disconnect(); analyser.disconnect(); dest.disconnect(); ac.close(); throw new Error('Captured video is empty/suspiciously small; please record a bit longer and try again.'); }
    src.disconnect(); analyser.disconnect(); dest.disconnect(); ac.close();
    return webm;
  }

  /* ============================ MP4 EXPORT ============================ */
  const exportMP4 = async () => {
    try {
      setErr(null); setIsExporting(true); setPhase('render'); setRenderPct(0);
      const webm = await renderWebMBlob((p) => setRenderPct(p));
      const fd = new FormData(); fd.append('file', webm, 'in.webm');
      setPhase('encode');
      const r = await fetch('/api/convert-mp4', { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        let payload: any = null;
        try { payload = ct.includes('application/json') ? await r.json() : { text: await r.text() }; }
        catch { try { payload = { text: await r.text() }; } catch {} }
        const msg = (payload && payload.stderrTail)
          ? `MP4 export failed.\nffmpeg: ${payload.usedBinary || payload.ffmpegPathTried}\n\n${payload.stderrTail}`
          : payload?.error || payload?.text || `HTTP ${r.status} ${r.statusText}`;
        setErr(msg); return;
      }
      setPhase('save');
      const mp4 = await r.blob();
      const url = URL.createObjectURL(mp4);
      const a = document.createElement('a'); a.href = url; a.download = `audiograffiti-${FORMAT.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.mp4`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(e?.message || 'MP4 export failed');
    } finally {
      setIsExporting(false); setPhase('idle'); setRenderPct(0);
      if (audioRef.current && audioUrl) {
        const t = audioRef.current.currentTime || 0;
        audioRef.current.src = audioUrl; audioRef.current.currentTime = t;
        audioRef.current.muted = false; audioRef.current.volume = 1;
      }
    }
  };

  /* =============================== UI =============================== */
  const currentText = useMemo(() => (segments[currentIdx]?.text || transcript || ''), [segments, currentIdx, transcript]);

  // Format selector component
  const FormatSelector = () => (
    <div className="mb-3 p-3 rounded-xl bg-black/20 border border-white/10">
      <div className="text-sm opacity-80 mb-2">Platform Format</div>
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
            <div className="text-xs opacity-70">{format.width}×{format.height}</div>
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
          <div className="h-1.5 w-28 rounded-full bg-white/15 overflow-hidden"><div className="h-full w-2/3 bg-white/40 rounded-full" /></div>
        </div>

        {/* Format selector */}
        <FormatSelector />

        {/* controls */}
        <div className="flex flex-wrap gap-2 mb-3">
          {!isRecording ? (
            <button onClick={startRecord} className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm">Record</button>
          ) : (
            <button onClick={stopRecord} className="px-3 py-1.5 bg-red-500/90 hover:bg-red-500 rounded-md text-sm">Stop</button>
          )}
          <label className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm cursor-pointer">
            Upload Audio
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => onUploadAudio(e.target.files?.[0] ?? null)} />
          </label>
          <label className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm cursor-pointer">
            Artwork
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onUploadArtwork(e.target.files?.[0] ?? null)} />
          </label>
          {artSource && <button onClick={clearArtwork} className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-md text-sm">Clear Art</button>}
          <button onClick={transcribe} className="px-3 py-1.5 bg-yellow-500/90 hover:bg-yellow-500 rounded-md text-sm ml-auto">Transcribe</button>
        </div>

        {/* TTS composer */}
        <div className="mb-3 rounded-xl border border-white/10 bg-black/20">
          <button className="w-full text-left px-3 py-2 text-sm flex items-center justify-between" onClick={() => setTtsOpen(o => !o)}>
            <span className="opacity-80">Text → Speech (optional)</span>
            <span className="opacity-60">{ttsOpen ? '−' : '+'}</span>
          </button>
          {ttsOpen && (
            <div className="px-3 pb-3">
              <textarea value={ttsText} onChange={(e) => setTtsText(e.target.value)} rows={3}
                        className="w-full rounded-md bg-white/10 border border-white/10 p-2 text-sm"
                        placeholder="Type your script here…" maxLength={1000} />
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <div className="flex gap-1 flex-wrap">
                  {voices.map(v => (
                    <button key={v} onClick={() => setTtsVoice(v)}
                      className={`px-2 py-1 rounded-md text-xs border ${ttsVoice === v ? 'bg-yellow-500/90 text-black border-yellow-300' : 'bg-white/10 hover:bg-white/20 border-white/15'}`}>
                      {v}
                    </button>
                  ))}
                </div>
                <button onClick={generateTTS} disabled={isTtsBusy || !ttsText.trim()}
                        className="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-sm disabled:opacity-60">
                  {isTtsBusy ? 'Generating…' : 'Generate TTS'}
                </button>
                <div className="text-xs opacity-60 ml-auto">{ttsText.trim().length}/1000</div>
              </div>
            </div>
          )}
        </div>

        {/* swatches */}
        <div className="flex gap-2 mb-2">
          {PRESETS.map((g, i) => (
            <button
              key={i}
              onClick={() => { setPresetIdx(i); /* keep Auto BG on */ }}
              aria-label={`Background ${i + 1}`}
              className={`h-6 w-10 rounded-md border ${presetIdx === i ? 'border-white/80' : 'border-white/20'}`}
              style={{ background: `linear-gradient(180deg, ${g[0]}, ${g[1]})` }}
            />
          ))}
          <div className="flex items-center gap-2 ml-auto text-xs opacity-80">
            <span>Auto BG</span>
            <button onClick={() => setAutoBg(v => !v)} className={`px-2 py-1 rounded ${autoBg ? 'bg-yellow-500/90 text-black' : 'bg-white/15 hover:bg-white/25'}`}>
              {autoBg ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        {/* LIVE PREVIEW */}
        <div className="rounded-2xl overflow-hidden border border-white/10" style={{ height: '560px' }}>
          <canvas ref={previewRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>

        {/* export row */}
        <div className="mt-3 grid grid-cols-2 gap-2 items-stretch">
          <button onClick={exportMP4} disabled={isExporting} className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20 text-sm disabled:opacity-60">
            Export MP4
          </button>
          <div className="flex items-center justify-end text-xs opacity-70">
            {isExporting ? (
              phase === 'render' ? `Rendering… ${renderPct}%`
              : phase === 'encode' ? 'Encoding…'
              : phase === 'save' ? 'Saving…'
              : 'Working…'
            ) : null}
          </div>
        </div>

        {/* player */}
        <div className="mt-2 p-3 rounded-xl bg-black/20 border border-white/10">
          <audio ref={audioRef} src={audioUrl || undefined} controls playsInline className="w-full" />
          <div className="mt-1 flex justify-between text-xs opacity-70">
            <div>Chunks: {Math.max(1, segments.length)}</div>
            <div>Current: {segments.length ? `${currentIdx + 1}/${segments.length}` : '—'}</div>
          </div>
        </div>

        {err && <div className="mt-3 text-sm text-red-300 bg-red-900/30 rounded-md p-2 border border-red-400/30 whitespace-pre-wrap">{err}</div>}
      </div>
    </div>
  );
}