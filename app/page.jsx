'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SignInButton, SignUpButton, UserButton, useAuth, useUser } from "@clerk/nextjs";

/* ============================ CONSTANTS ============================ */
const FORMATS = {
  '9:16': { width: 1080, height: 1920, name: 'Vertical (9:16)' },
  '1:1':  { width: 1080, height: 1080,  name: 'Square (1:1)' },
};

const FPS = 30;
const MAX_LINES = 3;
const MAX_WORDS_PER_SEGMENT = 18;
const DEFAULT_VOICE = 'nova';
const VOICE_STORAGE_KEY = 'ag:lastVoice';



// Plan-based character limits
const PLAN_LIMITS = {
  free: { maxChars: 1500, displayName: 'Free' },
  pro: { maxChars: 2500, displayName: 'Pro' }
};

const PRESETS = [
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

/* ============================== UTILS ============================== */

function splitWords(s) {
  return s.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
}

function coalesceSegments(segments, minDur = 0.4) {
  const out = [];
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
function tightenSegments(segs, maxWords = MAX_WORDS_PER_SEGMENT) {
  const out = [];
  for (const s of segs) {
    const words = splitWords(s.text);
    if (words.length <= maxWords) {
      out.push(s);
      continue;
    }
    const chunks = [];
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
function reflowTextOntoTimings(segs, originalText) {
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

  const out = [];
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
function normalizeSegments(segs, totalDurGuess) {
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
    Number.isFinite(totalDurGuess) && totalDurGuess > 0
      ? totalDurGuess
      : last?.end ?? 0;
  if (last && total > 0) last.end = Math.max(last.end, total);
  return out;
}

function wrapCaption(ctx, text, maxWidth) {
  const words = (text || '').split(' ').filter(Boolean);
  const lines = [];
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

function roundedRectPath(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

function roundedRectFill(g, x, y, w, h, r) {
  roundedRectPath(g, x, y, w, h, r);
  g.fill();
}

/** Pick a MediaRecorder MIME that the browser supports */
function pickRecorderMime() {
  const cands = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const t of cands) {
    try {
      if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
    } catch {}
  }
}

/* ---------- gradient helpers ---------- */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function mixHex(a, b, t) {
  const A = hexToRgb(a),
    B = hexToRgb(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  return `rgb(${r},${g},${bl})`;
}

function gradientAtTime(t, dur, startIdx) {
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
function drawImageCoverRounded(ctx, img, dx, dy, dW, dH, radius = 28, opacity = 1) {
  ctx.save();
  roundedRectPath(ctx, dx, dy, dW, dH, radius);
  ctx.clip();
  const iW = img.width,
    iH = img.height;
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
  ctx.drawImage(img, x, y, rW, rH);
  ctx.restore();
}

/* ---------- TTS segmenting fallback ---------- */
function buildSegmentsFromTextAndDuration(text, durationSec, targetSegSec = 2.2, _minWords = 10, maxWords = MAX_WORDS_PER_SEGMENT) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length)
    return [{ start: 0, end: Math.max(1, durationSec), text: '' }];
  const FIXED_WORDS_PER_SEGMENT = 6; // steady visual rhythm
  const chunks = [];
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
function slideForTime(t, totalDuration, slides) {
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
function segmentIndexAtTime(segs, t, holdGapSec = 0.05, leadInSec = 0.03, tailOutSec = 0.06) {
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

/* ====================== USER PLAN DETECTION ====================== */
function getUserPlan(user) {
  if (!user) return 'free';
  
  // Check Stripe subscription status from Clerk metadata
  const subscriptionPlan = user?.publicMetadata?.subscriptionPlan;
  const subscriptionStatus = user?.publicMetadata?.subscriptionStatus;
  
  // User has active Pro subscription via Stripe
  if (subscriptionPlan === 'pro' && subscriptionStatus === 'active') {
    return 'pro';
  }
  
  // Default to free plan
  return 'free';
}

/* =========================== COMPONENT ============================ */
export default function Page() {
  const { isSignedIn } = useAuth();
  const { user } = useUser();

  /* User plan detection - production ready */
  const userPlan = useMemo(() => {
    if (!user) return 'free';
    return getUserPlan(user);
  }, [user]);

  /* Format state */
  const [selectedFormat, setSelectedFormat] = useState('1:1');

  /* Dynamic dimensions */
  const FORMAT = FORMATS[selectedFormat];
  const WIDTH = FORMAT?.width || 1080;
  const HEIGHT = FORMAT?.height || 1920;

  /* Responsive layout */
  const isSquare = WIDTH === HEIGHT;
  const CAP_TOP = isSquare ? HEIGHT * 0.83 : 1200; // Text starts at 83% down (bottom 17%)
  const CAP_BOTTOM = HEIGHT - 96;
  const CAP_BOX_H = CAP_BOTTOM - CAP_TOP;

  /* Audio + recording */
  const audioRef = useRef(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecRef = useRef(null);
  const recChunksRef = useRef([]);

  /* Transcript + segments */
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);

  /* UI */
  const [presetIdx, setPresetIdx] = useState(1);
  const [autoBg, setAutoBg] = useState(true);

  /* Export status */
  const [isExporting, setIsExporting] = useState(false);
  const [err, setErr] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [renderPct, setRenderPct] = useState(0);

  /* Export capability detection */
  const [exportSupported, setExportSupported] = useState(null);
  const [exportReason, setExportReason] = useState('');

  /* TTS */
  const [voices] = useState([
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
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState(DEFAULT_VOICE);
  const [isTtsBusy, setIsTtsBusy] = useState(false);

  /* Artwork (up to 3 images) */
  const [artworks, setArtworks] = useState([]);
  const [artOpacity, setArtOpacity] = useState(1);

  /* Custom branding text for Pro users */
  const [customBrandingText, setCustomBrandingText] = useState('');
  const [isUpgrading, setIsUpgrading] = useState(false);
  /* Wake lock */
  const [wakeLock, setWakeLock] = useState(null);

  /* -------- Uniform caption metrics -------- */
  const capMetricsMemoRef = useRef(null);
  function computeUniformCaptionMetrics(ctx, segs, fallbackText) {
    const maxWidth = WIDTH * 0.94;
    const texts = segs?.map((s) => (s.text || '').trim()).filter(Boolean) ?? [];
    if (!texts.length)
      texts.push((fallbackText || '').trim() || 'Record or upload a short');

    const sizeFor = (text) => {
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

  /* ======================= STRIPE UPGRADE ======================= */
  const handleUpgradeClick = async () => {
    try {
      setIsUpgrading(true);
      
      if (!user?.emailAddresses?.[0]?.emailAddress) {
        setErr('Email address required for upgrade');
        return;
      }
      
      const email = user.emailAddresses[0].emailAddress;
      
      const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to create checkout session');
      }
      
      const { url } = await response.json();
      window.location.href = url;
      
    } catch (error) {
      console.error('Upgrade error:', error);
      setErr('Failed to start upgrade process. Please try again.');
    } finally {
      setIsUpgrading(false);
    }
  };

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
    } catch (e) {
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
  const onUploadAudio = async (f) => {
    if (!f) return;
    setErr(null);
    const url = URL.createObjectURL(f);
    setAudioUrl(url);
  };

  async function fileToCanvasImageSource(f) {
    const bmp = await window.createImageBitmap?.(f).catch(() => null);
    if (bmp) return bmp;
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode();
    return img;
  }

  const onUploadArtwork = async (files) => {
    if (!files || !files.length) return;
    setErr(null);

    // Keep native selection order; cap at 3
    let arr = Array.from(files).slice(0, 3);

    // If all files start with a number prefix, sort by that number.
    const leadingNum = (name) => {
      const m = name.trim().match(/^(\d{1,4})[\s._-]?/);
      return m ? parseInt(m[1], 10) : NaN;
    };
    const allNumbered = arr.every((f) => !Number.isNaN(leadingNum(f.name)));
    if (allNumbered) {
      arr = arr.sort((a, b) => leadingNum(a.name) - leadingNum(b.name));
    }

    const items = [];
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
      setIsTranscribing(true);
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
        let msg;
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

      let segs = data?.segments?.map((s) => ({
          start: s.start,
          end: s.end,
          text: (s.text || '').trim(),
        })) || [];

      const durGuess = segs[segs.length - 1]?.end ?? 0;
      setSegments(normalizeSegments(segs, durGuess));
      setCurrentIdx(0);
      capMetricsMemoRef.current = null;
    } catch (e) {
      setErr(e?.message || 'Transcription failed.');
    } finally {
      setIsTranscribing(false);
    }
  };

  /* ========================= TTS ============================ */
  const generateTTS = async () => {
    try {
      if (!ttsText.trim()) return;

      // Enforce character limits based on user plan
      const limit = PLAN_LIMITS[userPlan];
      if (ttsText.trim().length > limit.maxChars) {
        setErr(`Text exceeds ${limit.displayName} plan limit of ${limit.maxChars} characters. Current: ${ttsText.trim().length} characters.`);
        return;
      }

      setIsTtsBusy(true);
      setErr(null);

      // Step 1: Generate TTS audio with user plan
      const tt = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ttsText.trim(),
          voice: ttsVoice,
          format: 'mp3',
          userPlan: userPlan, // Pass the actual user plan
        }),
      });
      if (!tt.ok) {
        let msg;
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
        await new Promise((res, rej) => {
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
        let msg;
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
      let whisperSegs = transcribeData?.segments?.map((s) => ({
          start: s.start,
          end: s.end,
          text: (s.text || '').trim(),
        })) || [];

      // Use Whisper's segments directly for best timing
      const reflowedSegs = whisperSegs.length > 0 
        ? whisperSegs
        : buildSegmentsFromTextAndDuration(ttsText.trim(), dur);
      const finalSegs = normalizeSegments(
        reflowedSegs,
        dur
      ); 

      setTranscript(transcribeData?.text || ttsText.trim());
      setSegments(finalSegs);
      setCurrentIdx(0);
      capMetricsMemoRef.current = null;
    } catch (e) {
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
          const lock = await navigator.wakeLock.request('screen');
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

  /* ===================== EXPORT SUPPORT DETECTOR ===================== */
  function detectExportSupport() {
    const hasCanvasCapture =
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function';
    const hasMR = typeof window !== 'undefined' && 'MediaRecorder' in window;

    if (!hasCanvasCapture || !hasMR) {
      return { ok: false, reason: 'Missing canvas.captureStream or MediaRecorder.' };
    }

    const isTypeSupported = window.MediaRecorder?.isTypeSupported?.bind(
      window.MediaRecorder
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
  function drawFrame(ctx, t, grad, segs, transcriptText, bars, art, artOp, plan, customText) {
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
    const midY = isSquare ? HEIGHT * 0.75 : CAP_TOP - 120;
    
    // Artwork area
    const artTop = isSquare ? 80 : 120;
    const artBottom = midY - maxBarH / 2 - (isSquare ? 50 : 60);
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
      const { size: CAP_SIZE, lineHeight: CAP_LH } = capMetricsMemoRef.current;

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

    // Text-based watermark system (free/pro)
    if (plan === 'free') {
      ctx.save();
      
      // Watermark dimensions - responsive to canvas width
      const wmHeight = Math.round(HEIGHT * 0.06);
      const wmWidth = Math.min(WIDTH * 0.75, WIDTH - 20); // Max 75% width, min 20px margins
      
      // Position in upper right with safe margins
      const wmX = WIDTH - wmWidth - 10;
      const wmY = HEIGHT * 0.05;
      
      // Semi-transparent background for readability
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      roundedRectFill(ctx, wmX, wmY, wmWidth, wmHeight, 8);
      
      // Calculate font size that fits the available width
      const watermarkText = 'Start creating free audiograms at AudioGraffiti.co';
      let fontSize = Math.round(wmHeight * 0.32);
      ctx.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      
      // Measure text and reduce font size if it doesn't fit
      let textWidth = ctx.measureText(watermarkText).width;
      const maxTextWidth = wmWidth - 20; // 10px padding on each side
      
      while (textWidth > maxTextWidth && fontSize > 10) {
        fontSize -= 1;
        ctx.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        textWidth = ctx.measureText(watermarkText).width;
      }
      
      // If still too long, use shorter fallback text
      let finalText = watermarkText;
      if (textWidth > maxTextWidth) {
        finalText = 'AudioGraffiti.co - Upgrade to customize';
        textWidth = ctx.measureText(finalText).width;
        
        // If even fallback is too long, use minimal text
        if (textWidth > maxTextWidth) {
          finalText = 'AudioGraffiti.co';
        }
      }
      
      ctx.fillStyle = '#F4D03F'; // Golden yellow
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(finalText, wmX + wmWidth/2, wmY + wmHeight/2);
      
      ctx.restore();
    } else if (plan === 'pro' && customText.trim()) {
      // Pro user with custom branding text
      ctx.save();
      
      // Watermark dimensions
      const wmHeight = Math.round(HEIGHT * 0.06);
      const wmWidth = Math.round(WIDTH * 0.5);
      
      // Position in upper right
      const wmX = WIDTH - wmWidth - 10;
      const wmY = HEIGHT * 0.05;
      
      // Semi-transparent background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      roundedRectFill(ctx, wmX, wmY, wmWidth, wmHeight, 8);
      
      // Custom branding text with size fitting
      let fontSize = Math.round(wmHeight * 0.4);
      ctx.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      
      let textWidth = ctx.measureText(customText.trim()).width;
      const maxTextWidth = wmWidth - 20;
      
      while (textWidth > maxTextWidth && fontSize > 10) {
        fontSize -= 1;
        ctx.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        textWidth = ctx.measureText(customText.trim()).width;
      }
      
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(customText.trim(), wmX + wmWidth/2, wmY + wmHeight/2);
      
      ctx.restore();
    }
    // Pro users with no custom text get completely clean videos (no watermark)
  }

  /* ======================= RENDER → WEBM (export) ======================= */
  async function renderWebMBlob(onProgress) {
    if (!audioUrl) throw new Error('No audio.');
    const a = new Audio(audioUrl);
    a.crossOrigin = 'anonymous';
    a.preload = 'auto';
    await new Promise((res) => {
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
    const ctx = off.getContext('2d');

    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaElementSource(a);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    const dest = ac.createMediaStreamDestination();
    src.connect(analyser);
    analyser.connect(dest);
    // Do NOT connect to ac.destination here to avoid double audio during export

    const videoStream = off.captureStream(FPS);
    const mixed = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const mime = pickRecorderMime();
    const rec = mime
      ? new MediaRecorder(mixed, { mimeType: mime })
      : new MediaRecorder(mixed);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => {
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
    let raf = 0;
    let fallbackInterval = null;

    const tick = () => {
      const currentTime = a.currentTime || 0;

      const b = computeBars();
      const grad = autoBg
        ? gradientAtTime(currentTime, totalDuration, presetIdx)
        : PRESETS[presetIdx];

      const slide = slideForTime(
        currentTime,
        totalDuration,
        artworks.map((x) => ({ img: x.img }))
      );

      drawFrame(ctx, currentTime, grad, segs, transcript, b, slide, artOpacity, userPlan, customBrandingText);

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
    let exportLock = null;
    try {
      if (exportSupported === false) {
        setErr('Export is not supported in this browser. Try desktop Chrome/Edge/Firefox.');
        return;
      }

      try { exportLock = await navigator?.wakeLock?.request?.('screen'); } catch {}

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
        let payload = null;
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
    } catch (e) {
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

  // Authentication check - if not signed in, show sign-in interface
  if (!isSignedIn) {
    return (
      <div className="min-h-dvh w-full bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,.9),#000)] text-white flex items-center justify-center p-4">
        <div className="w-[420px] max-w-[92vw] rounded-2xl bg-white/5 backdrop-blur-sm shadow-2xl border border-white/10 p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">AudioGraffiti</h1>
          <p className="mb-6 opacity-80">Professional audiograms for LinkedIn</p>
          <div className="space-y-3">
            <SignInButton mode="modal">
              <button className="w-full px-4 py-2 bg-yellow-500/90 hover:bg-yellow-500 text-black rounded-md font-medium">
                Sign In
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="w-full px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md">
                Sign Up
              </button>
            </SignUpButton>
          </div>
        </div>
      </div>
    );
  }

  // If signed in, show the main AudioGraffiti interface
  return (
    <div className="min-h-dvh w-full bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,.9),#000)] text-white flex items-center justify-center p-4">
      <div className="w-[420px] max-w-[92vw] rounded-2xl bg-white/5 backdrop-blur-sm shadow-2xl border border-white/10 p-4">
        {/* header */}
        <div className="flex items-center justify-between mb-4">
          <img 
            src="/audiograffiti-logo.png" 
            alt="AudioGraffiti" 
            className="h-8 w-auto"
          />
          <UserButton />
        </div>

        {/* Export support banner */}
        {exportSupported === false && (
          <div className="mb-4 rounded-lg border border-yellow-400/40 bg-yellow-500/10 text-yellow-100 p-3 text-sm">
            <div className="font-medium">Export not supported in this browser.</div>
            <div className="mt-1 opacity-80">
              Please use <b>desktop Chrome, Edge, or Firefox</b> (Android Chrome also works).
            </div>
            {exportReason && <div className="mt-1 opacity-60 text-xs">{exportReason}</div>}
          </div>
        )}

        {/* Aspect Ratio Section */}
        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">Aspect Ratio</div>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(FORMATS).map(([key, format]) => (
              <button
                key={key}
                onClick={() => setSelectedFormat(key)}
                className={`px-3 py-2 rounded-lg text-sm border transition-colors ${
                  selectedFormat === key
                    ? 'bg-yellow-500/90 text-black border-yellow-300 font-medium'
                    : 'bg-white/10 hover:bg-white/20 border-white/15 text-white/90'
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

        {/* Voice Section */}
        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">Voice</div>
          <div className="flex gap-2 mb-2">
            {!isRecording ? (
              <button
                onClick={startRecord}
                className="px-4 py-2 rounded-lg text-sm bg-green-500/90 hover:bg-green-500 text-black border border-green-300 font-medium"
              >
                Record
              </button>
            ) : (
              <button
                onClick={stopRecord}
                className="px-4 py-2 bg-red-500/90 hover:bg-red-500 rounded-lg text-sm text-white font-medium"
              >
                Stop
              </button>
            )}

            <label className="px-4 py-2 bg-amber-500/90 hover:bg-amber-500 rounded-lg text-sm cursor-pointer text-black font-medium">
              Upload Audio
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => onUploadAudio(e.target.files?.[0] ?? null)}
              />
            </label>

            {/* Status indicator */}
            <div className={`ml-auto px-2 py-1 rounded-full text-xs font-medium flex items-center gap-1 ${
              audioUrl && audioUrl.length > 0
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                audioUrl && audioUrl.length > 0 ? 'bg-green-400' : 'bg-gray-400'
              }`} />
              {audioUrl && audioUrl.length > 0 ? 'Ready' : 'No Audio'}
            </div>
          </div>
          
          {/* Transcribe button */}
          <button
            onClick={transcribe}
            disabled={!audioUrl || isTranscribing}
            className={`w-full px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed ${
              segments.length > 0
                ? 'bg-green-500/90 hover:bg-green-500 text-black border border-green-300'
                : isTranscribing
                ? 'bg-blue-500/90 text-white'
                : 'bg-yellow-500/90 hover:bg-yellow-500 text-black'
            }`}
          >
            {isTranscribing 
              ? 'Transcribing...' 
              : segments.length > 0 
              ? 'Transcription Complete ✓'
              : 'Transcribe'
            }
          </button>
        </div>

        {/* TTS Section */}
        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">
            TTS {userPlan === 'pro' && <span className="text-xs bg-green-500/90 text-black px-1.5 py-0.5 rounded ml-1">HD</span>}
          </div>
          
          {/* Voice selection */}
          <div className="flex gap-1 flex-wrap mb-3">
            {voices.map((v) => (
              <button
                key={v}
                onClick={() => setTtsVoice(v)}
                className={`px-2 py-1 rounded-md text-xs border ${
                  ttsVoice === v
                    ? 'bg-yellow-500/90 text-black border-yellow-300'
                    : 'bg-white/10 hover:bg-white/20 border-white/15 text-white/90'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {/* TTS Script */}
          <div className="mb-2">
            <div className="text-xs text-white/70 mb-1">TTS Script</div>
            <textarea
              value={ttsText}
              onChange={(e) => setTtsText(e.target.value)}
              rows={3}
              className="w-full rounded-lg bg-white/10 border border-white/15 p-3 text-sm text-white placeholder-white/50 resize-none"
              placeholder="Type your script here…"
              maxLength={PLAN_LIMITS[userPlan].maxChars}
            />
          </div>

          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={generateTTS}
              disabled={isTtsBusy || !ttsText.trim() || ttsText.trim().length > PLAN_LIMITS[userPlan].maxChars}
              className="px-4 py-2 rounded-lg text-sm bg-green-500/90 hover:bg-green-500 text-black border border-green-300 font-medium disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isTtsBusy ? 'Generating…' : 'Generate TTS'}
            </button>
            
            {/* Character count with plan limits */}
            <div className="text-xs ml-auto">
              <div className={`${
                ttsText.trim().length > PLAN_LIMITS[userPlan].maxChars 
                  ? 'text-red-400' 
                  : ttsText.trim().length > PLAN_LIMITS[userPlan].maxChars * 0.9
                  ? 'text-yellow-400'
                  : 'text-white/60'
              }`}>
                {ttsText.trim().length} / {PLAN_LIMITS[userPlan].maxChars}
              </div>
              <div className="text-white/50 text-[10px]">
                {userPlan === 'free' ? 'Free limit' : 'Pro limit'}
              </div>
            </div>
          </div>

          {/* Character limit warning/upgrade prompt */}
          {ttsText.trim().length > PLAN_LIMITS[userPlan].maxChars && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-400/30 rounded-lg p-2">
              {userPlan === 'free' ? (
                <>Text exceeds Free plan limit. <span className="text-yellow-400">Upgrade to Pro</span> for {PLAN_LIMITS.pro.maxChars} character limit.</>
              ) : (
                <>Text exceeds Pro plan limit of {PLAN_LIMITS.pro.maxChars} characters.</>
              )}
            </div>
          )}
        </div>

        {/* Artwork Section */}
        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">Artwork</div>
          
          <div className="flex gap-2 mb-3">
            <label className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm cursor-pointer border border-white/15 text-white/90">
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
                className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm border border-white/15 text-white/90"
              >
                Clear Art
              </button>
            )}
          </div>

         {/* Artwork preview and controls */}
        {artworks.length > 0 && (
          <div className="mb-3 p-3 rounded-lg bg-black/20 border border-white/10">
            <div className="flex items-center gap-2 mb-2">
              {artworks.map((a, i) => (
                <div
                  key={a.url}
                  className="relative h-10 w-10 rounded-md overflow-hidden border border-white/20"
                  title={`Image ${i + 1}`}
                >
                  <img
                    src={a.url}
                    alt={`Artwork ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute -top-1 -left-1 text-[9px] px-1 py-0.5 rounded bg-black/80 border border-white/30 text-white">
                    {i + 1}
                  </span>
                </div>
              ))}

              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => setArtworks((prev) => [...prev].reverse())}
                  className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 border border-white/15 text-white/90"
                >
                  Reverse
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setArtworks((prev) => (prev.length ? [...prev.slice(1), prev[0]] : prev))
                  }
                  className="px-2 py-1 text-xs rounded bg-white/10 hover:bg-white/20 border border-white/15 text-white/90"
                >
                  Rotate
                </button>
              </div>
            </div>
            <div className="text-[10px] text-white/60">
              Order: 1 → 2 → 3 during playback
            </div>
          </div>
        )}
      </div>

      {/* Custom Branding Section TEMPORARILY DISABLED FOR FREE-TIER LAUNCH - RESTORE AFTER CRUISE
      <div className="mb-4 rounded-lg border border-white/10 bg-black/20 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-white/90">Custom Branding</span>
          <span className={`px-2 py-1 rounded text-xs font-medium ${
            userPlan === 'pro' 
              ? 'bg-green-500/90 text-black' 
              : 'bg-gray-500/90 text-white'
          }`}>
            {userPlan === 'pro' ? 'PRO' : 'FREE'}
          </span>
        </div>
        <div className="text-xs text-white/70 mb-2">
          {userPlan === 'free' 
            ? 'Free videos include "Powered by AudioGraffiti.co" watermark. Upgrade to Pro for custom branding.' 
            : 'Add your custom text to brand your videos (company name, website, tagline, etc.)'
          }
        </div>
        {userPlan === 'pro' ? (
          <div>
            <input
              type="text"
              value={customBrandingText}
              onChange={(e) => setCustomBrandingText(e.target.value)}
              placeholder="Enter your branding text (e.g., YourCompany.com)"
              className="w-full rounded-lg bg-white/10 border border-white/15 p-2 text-sm text-white placeholder-white/50"
              maxLength={50}
            />
            <div className="mt-1 text-xs text-white/60">
              {customBrandingText.length}/50 characters
            </div>
          </div>
        ) : (
          <button
            onClick={handleUpgradeClick}
            disabled={isUpgrading}
            className="w-full bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 disabled:from-gray-500 disabled:to-gray-600 disabled:cursor-not-allowed text-black font-medium py-2 px-4 rounded-lg transition-all duration-200 text-sm"
          >
            {isUpgrading ? 'Loading...' : 'Upgrade to Pro - $19/month'}
          </button>
        )}
      </div>*/}

      {/* Background swatches */}
      <div className="mb-4">
        <div className="flex gap-2 items-center">
          {PRESETS.map((g, i) => (
            <button
              key={i}
              onClick={() => setPresetIdx(i)}
              className={`h-6 w-8 rounded-md border transition-all ${
                presetIdx === i ? 'border-white/80 scale-110' : 'border-white/20 hover:border-white/40'
              }`}
              style={{ background: `linear-gradient(180deg, ${g[0]}, ${g[1]})` }}
            />
          ))}
          
          <div className="flex items-center gap-2 ml-auto text-xs text-white/80">
            <span>Auto BG</span>
            <button
              onClick={() => setAutoBg((v) => !v)}
              className={`px-2 py-1 rounded transition-colors ${
                autoBg 
                  ? 'bg-yellow-500/90 text-black font-medium' 
                  : 'bg-white/15 hover:bg-white/25 text-white/90'
              }`}
            >
              {autoBg ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </div>

      {/* Export Section */}
      <div className="mb-4">
        <button
          onClick={exportMP4}
          disabled={isExporting || exportSupported === false || !segments.length}
          className="w-full px-4 py-3 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed border border-white/15"
          title={
            exportSupported === false 
              ? 'Use desktop Chrome/Edge/Firefox for export' 
              : !segments.length 
              ? 'Transcribe audio first'
              : undefined
          }
        >
          Export MP4
        </button>
        
        {isExporting && (
          <div className="mt-2 text-xs text-white/70 text-center">
            {phase === 'render'
              ? `Rendering… ${renderPct}%`
              : phase === 'encode'
              ? 'Encoding…'
              : phase === 'save'
              ? 'Saving…'
              : 'Working…'}
          </div>
        )}
      </div>

      {/* Audio Player */}
      <div className="p-3 rounded-lg bg-black/20 border border-white/10">
        <audio
          ref={audioRef}
          src={audioUrl || undefined}
          controls
          playsInline
          preload="auto"
          className="w-full mb-2"
        />
        <div className="flex justify-between text-xs text-white/60">
          <div>Segments: {Math.max(1, segments.length)}</div>
          <div>
            Current: {segments.length ? `${Math.min(currentIdx + 1, segments.length)}/${segments.length}` : '—'}
          </div>
        </div>
      </div>

      {/* Error display */}
      {err && (
        <div className="mt-3 text-sm text-red-300 bg-red-900/30 rounded-lg p-3 border border-red-400/30 whitespace-pre-wrap">
          {err}
        </div>
      )}
    </div>
  </div>
);
}