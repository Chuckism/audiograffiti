'use client';
export const dynamic = 'force-dynamic';
import React, { useEffect, useMemo, useRef, useState } from 'react';

/* ============================ CONSTANTS ============================ */
const FORMATS = {
  '4:3':  { width: 1280, height: 960,  name: 'Storyline (4:3)' },
};

const FPS = 30;
const MAX_LINES = 5;
const MAX_WORDS_PER_SEGMENT = 18;
const DEFAULT_VOICE = 'brittany';
const VOICE_STORAGE_KEY = 'ag:lastVoice';

const PLAN_LIMITS = {
  free: { maxChars: 50000, displayName: 'Free' },
  pro: { maxChars: 50000, displayName: 'Pro' }
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

  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
  }

  const last = out[out.length - 1];
  const total = Number.isFinite(totalDurGuess) && totalDurGuess > 0 ? totalDurGuess : last?.end ?? 0;
  if (last && total > 0) last.end = Math.max(last.end, total);
  return out;
}

/* ============= NEW: CHARACTER TAG PARSING ============= */

/**
 * Parse character-tagged script in format: [NAME]: dialogue
 * Returns: { lines: [{speaker, text}], characters: [unique names] }
 */
function parseCharacterScript(scriptText) {
  if (!scriptText || typeof scriptText !== 'string') {
    return { lines: [], characters: [] };
  }

  const lines = [];
  const characterSet = new Set();
  
  // Split by newlines and process each line
  const rawLines = scriptText.split('\n');
  
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue; // Skip empty lines
    
    // Match pattern: [CHARACTER]:, CHARACTER:, or **CHARACTER:** dialogue text
    // Supports uppercase letters, spaces, hyphens in character names
    // Flexible format accepts brackets and/or bold markdown
    const match = trimmed.match(/^\*?\*?\[?([A-Z][A-Z\s\-]*)\]?\*?\*?:\s*(.+)$/i);
    
    if (match) {
      const speaker = match[1].trim().toUpperCase();
      const text = match[2].trim();
      
      if (speaker && text) {
        lines.push({ speaker, text });
        characterSet.add(speaker);
      }
    }
  }
  
  return {
    lines,
    characters: Array.from(characterSet).sort()
  };
}

/* ====================================================== */

// Voice mapping: Character names (backend handles ElevenLabs mapping)
const VOICE_API_MAPPING = {
  'shawn': 'shawn',
  'chuck': 'chuck',
  'max': 'max',
  'boomer': 'boomer',
  'brittany': 'brittany',
  'kaitlyn': 'kaitlyn',
  'sage': 'sage',
  'randy': 'randy',
  'coral': 'coral'
};

// Voice color themes for default character images (using custom names)
const VOICE_THEMES = {
  shawn: { bg: '#2563EB', name: 'Shawn', apiVoice: 'Brian' },
  chuck: { bg: '#3B82F6', name: 'Chuck', apiVoice: 'Chuck Clone 2' },
  brittany: { bg: '#8B5CF6', name: 'Brittany', apiVoice: 'Adeline' },
  kaitlyn: { bg: '#EC4899', name: 'Kaitlyn', apiVoice: 'Rachel' },
  boomer: { bg: '#1F2937', name: 'Boomer', apiVoice: 'James' },
  sage: { bg: '#10B981', name: 'Sage', apiVoice: 'Kaylin' },
  max: { bg: '#F59E0B', name: 'Max', apiVoice: 'Adam Stone' },
  randy: { bg: '#9CA3AF', name: 'Randy', apiVoice: 'Ryan' },
  coral: { bg: '#F97316', name: 'Coral', apiVoice: 'Nicole' },
};

/**
 * Load character image from public folder
 * Returns a promise that resolves to { url, img }
 */
function loadCharacterImage(voiceName) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const imagePath = `/characters/${voiceName}.png`;
    
    img.onload = () => {
      resolve({ url: imagePath, img });
    };
    
    img.onerror = () => {
      console.warn(`Failed to load image for ${voiceName}, using placeholder`);
      // Fallback to colored placeholder if image fails to load
      resolve(generateDefaultCharacterImage(voiceName.toUpperCase(), voiceName));
    };
    
    img.src = imagePath;
  });
}
function generateDefaultCharacterImage(characterName, voiceName) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  
  const theme = VOICE_THEMES[voiceName] || VOICE_THEMES.shawn;
  
  // Draw background
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, 512, 512);
  
  // Draw character name
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 72px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(characterName, 256, 256);
  
  // Convert to image
  const img = new Image();
  img.src = canvas.toDataURL();
  return { url: img.src, img };
}

/**
 * Strip character tags from script for TTS generation
 * [ALEX]: Hello → Hello
 */
function stripCharacterTags(scriptText) {
  if (!scriptText) return '';
  const lines = scriptText.split('\n');
  return lines
    .map(line => {
      const match = line.match(/^\[([A-Z][A-Z\s\-]*)\]:\s*(.+)$/i);
      return match ? match[2].trim() : line;
    })
    .join('\n');
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

function pickRecorderMime() {
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const t of cands) {
    try {
      if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
    } catch {}
  }
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
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

function drawImageCoverRounded(ctx, img, dx, dy, dW, dH, radius = 28, opacity = 1) {
  ctx.save();
  roundedRectPath(ctx, dx, dy, dW, dH, radius);
  ctx.clip();
  const iW = img.width, iH = img.height;
  if (!iW || !iH) {
    ctx.restore();
    return;
  }
  const scale = Math.max(dW / iW, dH / iH);
  const rW = iW * scale, rH = iH * scale;
  const x = dx + (dW - rW) / 2;
  const y = dy + (dH - rH) / 2;
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.drawImage(img, x, y, rW, rH);
  ctx.restore();
}

function buildSegmentsFromTextAndDuration(text, durationSec) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [{ start: 0, end: Math.max(1, durationSec), text: '' }];
  const FIXED_WORDS_PER_SEGMENT = 12;
  const chunks = [];
  for (let i = 0; i < words.length; i += FIXED_WORDS_PER_SEGMENT) {
    chunks.push(words.slice(i, i + FIXED_WORDS_PER_SEGMENT).join(' '));
  }
  const per = durationSec / chunks.length;
  return chunks.map((t, i) => ({ start: i * per, end: (i + 1) * per, text: t }));
}

function slideForTime(t, totalDuration, slides) {
  if (!slides.length) return null;
  if (!isFinite(totalDuration) || totalDuration <= 0) return slides[0].img;
  const per = totalDuration / slides.length;
  const idx = Math.min(slides.length - 1, Math.floor(t / per));
  return slides[idx]?.img ?? null;
}

const EPS = 1e-3;
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

function getUserPlan(user) {
  if (!user) return 'free';
  const subscriptionPlan = user?.publicMetadata?.subscriptionPlan;
  const subscriptionStatus = user?.publicMetadata?.subscriptionStatus;
  if (subscriptionPlan === 'pro' && subscriptionStatus === 'active') return 'pro';
  return 'free';
}

export default function ClientPage() {
  const userPlan = 'free'; // No authentication - everyone gets free plan
  const [selectedFormat, setSelectedFormat] = useState('4:3');
  const FORMAT = FORMATS[selectedFormat];
  const WIDTH = FORMAT?.width || 1280;
  const HEIGHT = FORMAT?.height || 960;
  const CAP_TOP = 1200;
  const CAP_BOTTOM = HEIGHT - 96;
  const CAP_BOX_H = CAP_BOTTOM - CAP_TOP;
  const audioRef = useRef(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecRef = useRef(null);
  const recChunksRef = useRef([]);
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [presetIdx, setPresetIdx] = useState(1);
  const [autoBg, setAutoBg] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [err, setErr] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [renderPct, setRenderPct] = useState(0);
  const [exportSupported, setExportSupported] = useState(null);
  const [exportReason, setExportReason] = useState('');
  const [voices] = useState(['shawn', 'chuck', 'brittany', 'kaitlyn', 'boomer', 'sage', 'max', 'randy', 'coral']);
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState('brittany');
  const [isTtsBusy, setIsTtsBusy] = useState(false);
  const [artworks, setArtworks] = useState([]);
  const [artOpacity, setArtOpacity] = useState(1);
  const [customBrandingText, setCustomBrandingText] = useState('');
  
  // Character-switching states (max 2 characters for PrimoScenarios)
  const [detectedCharacters, setDetectedCharacters] = useState([]);
  const speakerTimingsRef = useRef(null); // Store actual speaker timings from backend
  const [characterImages, setCharacterImages] = useState({}); // { "ALEX": {url, img}, "JAMIE": {url, img} }
  const [characterVoices, setCharacterVoices] = useState({}); // { "ALEX": "alloy", "JAMIE": "nova" }
  
  const [wakeLock, setWakeLock] = useState(null);
  const capMetricsMemoRef = useRef(null);

  function computeUniformCaptionMetrics(ctx, segs, fallbackText) {
    const maxWidth = WIDTH * 0.94;
    const texts = segs?.map((s) => (s.text || '').trim()).filter(Boolean) ?? [];
    if (!texts.length) texts.push((fallbackText || '').trim() || 'Record or upload audio');
    const sizeFor = (text) => {
      let lo = 56, hi = 220, best = 56;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const lh = Math.round(mid * 1.14);
        ctx.font = `bold ${mid}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        const lines = wrapCaption(ctx, text, maxWidth);
        const ok = lines.length <= MAX_LINES && (lines.length - 1) * lh <= CAP_BOX_H;
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

  const onUploadAudio = async (f) => {
    if (!f) return;
    setErr(null);
    setAudioUrl(URL.createObjectURL(f));
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
    let arr = Array.from(files).slice(0, 3);
    const leadingNum = (name) => {
      const m = name.trim().match(/^(\d{1,4})[\s._-]?/);
      return m ? parseInt(m[1], 10) : NaN;
    };
    if (arr.every((f) => !Number.isNaN(leadingNum(f.name)))) {
      arr.sort((a, b) => leadingNum(a.name) - leadingNum(b.name));
    }
    const items = [];
    for (const f of arr) {
      try {
        const img = await fileToCanvasImageSource(f);
        items.push({ url: URL.createObjectURL(f), img });
      } catch {}
    }
    setArtworks(items);
  };

  const clearArtwork = () => {
    artworks.forEach((a) => URL.revokeObjectURL(a.url));
    setArtworks([]);
  };

  const transcribe = async () => {
    try {
      setErr(null);
      setIsTranscribing(true);
      if (!audioUrl) throw new Error('No audio to transcribe.');
      const res = await fetch(audioUrl);
      const blob = await res.blob();
      const fd = new FormData();
      fd.append('file', new File([blob], 'audio.webm', { type: blob.type || 'audio/webm' }));
      const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = (await r.json())?.error || msg; } catch {}
        throw new Error(msg || 'Transcription failed.');
      }
      const data = await r.json();
      setTranscript((data?.text || '').trim());
      const segs = data?.segments?.map((s) => ({ start: s.start, end: s.end, text: (s.text || '').trim() })) || [];
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

  const generateTTS = async () => {
    try {
      if (!ttsText.trim()) return;
      const limit = PLAN_LIMITS[userPlan];
      if (ttsText.trim().length > limit.maxChars) {
        setErr(`Text exceeds ${limit.displayName} plan limit of ${limit.maxChars} characters.`);
        return;
      }
      setIsTtsBusy(true);
      setErr(null);
      
      let tt;
      
      if (detectedCharacters.length > 0) {
        // MULTI-VOICE MODE: Build segments with character voices
        const parsed = parseCharacterScript(ttsText.trim());
        const segments = parsed.lines.map(line => {
          const customVoice = characterVoices[line.speaker] || 'shawn';
          const apiVoice = VOICE_API_MAPPING[customVoice] || 'alloy';
          return {
            text: line.text,
            voice: apiVoice // Convert to API voice name
          };
        });
        
        console.log(`Generating multi-voice TTS with ${segments.length} segments`);
        
        tt = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            segments: segments, 
            userPlan: userPlan 
          }),
        });
      } else {
        // SINGLE VOICE MODE: Original behavior
        const apiVoice = VOICE_API_MAPPING[ttsVoice] || 'alloy';
        tt = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            text: ttsText.trim(), 
            voice: apiVoice, // Convert to API voice name
            format: 'mp3', 
            userPlan: userPlan 
          }),
        });
      }
      if (!tt.ok) {
        let msg = await tt.text();
        try { msg = (await tt.json())?.error || msg; } catch {}
        throw new Error(msg || 'TTS failed.');
      }
      
      // Capture speaker timing data from backend
      const speakerTimingsHeader = tt.headers.get('X-Speaker-Timings');
      const speakerTimings = speakerTimingsHeader ? JSON.parse(speakerTimingsHeader) : null;
      if (speakerTimings) {
        console.log('Received speaker timings from backend:', speakerTimings);
        speakerTimingsRef.current = speakerTimings;
      }
      
      const audioBlob = await tt.blob();
      const url = URL.createObjectURL(audioBlob);
      setAudioUrl(url);
      let dur = 10;
      try {
        const probe = new Audio(url);
        await new Promise((res, rej) => {
          probe.addEventListener('loadedmetadata', () => {
            if (isFinite(probe.duration) && probe.duration > 0) dur = probe.duration;
            res();
          }, { once: true });
          probe.addEventListener('error', () => rej(new Error('probe failed')), { once: true });
          probe.load();
        });
      } catch {}
      const fd = new FormData();
      fd.append('file', new File([audioBlob], 'tts.mp3', { type: audioBlob.type || 'audio/mpeg' }));
      const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!transcribeResponse.ok) {
        let msg = await transcribeResponse.text();
        try { msg = (await transcribeResponse.json())?.error || msg; } catch {}
        throw new Error(msg || 'Transcription of TTS failed.');
      }
      const transcribeData = await transcribeResponse.json();
      const whisperSegs = transcribeData?.segments?.map((s) => ({ start: s.start, end: s.end, text: (s.text || '').trim() })) || [];
      const finalSegs = normalizeSegments(whisperSegs.length ? whisperSegs : buildSegmentsFromTextAndDuration(ttsText.trim(), dur), dur);
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

  useEffect(() => {
    try {
      const saved = localStorage.getItem(VOICE_STORAGE_KEY);
      if (saved && voices.includes(saved)) setTtsVoice(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(VOICE_STORAGE_KEY, ttsVoice); } catch {}
  }, [ttsVoice]);

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

  useEffect(() => { capMetricsMemoRef.current = null; }, [segments, transcript, selectedFormat]);

  // Auto-detect characters from tagged script (limit to 2 for PrimoScenarios)
  useEffect(() => {
    if (ttsText.trim()) {
      const parsed = parseCharacterScript(ttsText);
      const chars = parsed.characters.slice(0, 2); // Limit to 2 characters
      setDetectedCharacters(chars);
      
      // Auto-assign voices based on character names (1-to-1 match)
      // If character name doesn't match a voice, use next unused voice
      const newVoices = {};
      const usedVoices = new Set();
      
      // First pass: assign exact matches
      chars.forEach((char) => {
        const voiceName = char.toLowerCase();
        if (voices.includes(voiceName)) {
          newVoices[char] = voiceName;
          usedVoices.add(voiceName);
        }
      });
      
      // Second pass: assign unused voices to non-matching characters
      chars.forEach((char) => {
        if (!newVoices[char]) {
          // Find first unused voice
          const unusedVoice = voices.find(v => !usedVoices.has(v));
          newVoices[char] = unusedVoice || 'shawn'; // Fallback to shawn if all used
          usedVoices.add(newVoices[char]);
          console.log(`Character ${char} doesn't match a voice. Assigned ${newVoices[char]}.`);
        }
      });
      
      setCharacterVoices(newVoices);
      
      // Load actual character images from public folder
      const loadImages = async () => {
        const newImages = {};
        for (const char of chars) {
          const voice = newVoices[char] || 'shawn';
          try {
            newImages[char] = await loadCharacterImage(voice);
          } catch (err) {
            console.error(`Failed to load image for ${char}:`, err);
            // Fallback to placeholder
            newImages[char] = generateDefaultCharacterImage(char, voice);
          }
        }
        setCharacterImages(newImages);
      };
      
      loadImages();
    } else {
      setDetectedCharacters([]);
    }
  }, [ttsText]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator) {
        try {
          const lock = await navigator.wakeLock.request('screen');
          setWakeLock(lock);
          lock.addEventListener('release', () => setWakeLock(null));
        } catch (e) { console.log('Wake lock failed:', e); }
      }
    };
    const releaseWakeLock = () => {
      if (wakeLock) {
        wakeLock.release();
        setWakeLock(null);
      }
    };
    audio.addEventListener('play', requestWakeLock);
    audio.addEventListener('pause', releaseWakeLock);
    audio.addEventListener('ended', releaseWakeLock);
    return () => {
      audio.removeEventListener('play', requestWakeLock);
      audio.removeEventListener('pause', releaseWakeLock);
      audio.removeEventListener('ended', releaseWakeLock);
      releaseWakeLock();
    };
  }, [audioUrl, wakeLock]);

  useEffect(() => {
    const a = audioRef.current;
    if (a && audioUrl) {
      try {
        if (!a.paused) a.pause();
        a.src = audioUrl;
        a.muted = false;
        a.volume = 1;
        a.load();
      } catch (e) { console.warn('audio reload failed:', e); }
    }
  }, [audioUrl]);

  useEffect(() => {
    const res = (() => {
      const hasCanvasCapture = typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
      const hasMR = typeof window !== 'undefined' && 'MediaRecorder' in window;
      if (!hasCanvasCapture || !hasMR) return { ok: false, reason: 'Missing canvas.captureStream or MediaRecorder.' };
      const isTypeSupported = window.MediaRecorder?.isTypeSupported?.bind(window.MediaRecorder);
      const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      if (!!isTypeSupported && candidates.some((c) => isTypeSupported(c))) return { ok: true };
      return { ok: false, reason: 'MediaRecorder present but no compatible WebM profile.' };
    })();
    setExportSupported(res.ok);
    setExportReason(res.reason || '');
  }, []);

  /**
   * Map segments to speakers using actual timing from backend when available
   * Falls back to estimation if timing data not provided
   */
  function mapSegmentsToSpeakers(segments, scriptText, speakerTimings = null) {
    if (!scriptText || !segments.length) return segments;
    
    const parsed = parseCharacterScript(scriptText);
    if (!parsed.lines.length) return segments;
    
    // If we have actual timing from backend, use it!
    if (speakerTimings && speakerTimings.length > 0) {
      console.log('Using actual speaker timings from backend for perfect sync');
      
      return segments.map(segment => {
        const segmentMidpoint = (segment.start + segment.end) / 2;
        
        // Find which timing this segment falls into
        const timing = speakerTimings.find(t => 
          segmentMidpoint >= t.startTime && segmentMidpoint < t.endTime
        );
        
        const speaker = timing?.speaker || parsed.characters[0] || null;
        
        return {
          ...segment,
          speaker
        };
      });
    }
    
    // FALLBACK: Estimate timing (old approach)
    console.log('Estimating speaker timings (no backend data available)');
    
    const PAUSE_DURATION = 1.0;
    const INITIAL_SILENCE = 0.2;
    const totalAudioDuration = segments[segments.length - 1]?.end || 0;
    const totalScriptLength = parsed.lines.reduce((sum, line) => sum + line.text.length, 0);
    
    let speakerChanges = 0;
    for (let i = 1; i < parsed.lines.length; i++) {
      if (parsed.lines[i].speaker !== parsed.lines[i - 1].speaker) {
        speakerChanges++;
      }
    }
    
    const totalPauseTime = speakerChanges * PAUSE_DURATION;
    const totalSpeakingTime = Math.max(0, totalAudioDuration - totalPauseTime - INITIAL_SILENCE);
    
    const scriptTimeline = [];
    let cumulativeTime = 0.2;
    let lastSpeaker = null;
    
    for (const line of parsed.lines) {
      if (lastSpeaker && lastSpeaker !== line.speaker) {
        cumulativeTime += PAUSE_DURATION;
      }
      
      const lineDuration = (line.text.length / totalScriptLength) * totalSpeakingTime;
      scriptTimeline.push({
        speaker: line.speaker,
        startTime: cumulativeTime,
        endTime: cumulativeTime + lineDuration
      });
      cumulativeTime += lineDuration;
      lastSpeaker = line.speaker;
    }
    
    return segments.map(segment => {
      const segmentMidpoint = (segment.start + segment.end) / 2;
      
      const scriptLine = scriptTimeline.find(line => 
        segmentMidpoint >= line.startTime && segmentMidpoint < line.endTime
      );
      
      const speaker = scriptLine?.speaker || parsed.characters[0] || null;
      
      return {
        ...segment,
        speaker
      };
    });
  }

  // PRIMO SCENARIOS - Character-Switching Frame Renderer
  function drawFrame(ctx, t, grad, segs, transcriptText, bars, art, artOp, plan, customText) {
    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    g.addColorStop(0, grad[0]);
    g.addColorStop(1, grad[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Determine if we have character mode
    const hasCharacters = detectedCharacters.length > 0;
    
    if (hasCharacters) {
      // CHARACTER-SWITCHING MODE: 4:3 Split-screen layout
      const idx = segmentIndexAtTime(segs, t);
      const currentSeg = idx === -1 ? null : segs[idx];
      const speaker = currentSeg?.speaker || detectedCharacters[0];
      const characterImg = characterImages[speaker]?.img;
      
      // 4:3 format: Left = Character, Right = Caption
      const splitX = WIDTH / 2;
      
      // Draw character image on left half
      if (characterImg && characterImg.complete) {
        drawImageCoverRounded(ctx, characterImg, 0, 0, splitX, HEIGHT, 0, 1);
      }
      
      // Draw caption on right half
      if (currentSeg?.text) {
        const capX = splitX;
        const capW = WIDTH - splitX;
        const capH = HEIGHT;
        const maxWidth = capW * 0.9;
        
        if (!capMetricsMemoRef.current) {
          capMetricsMemoRef.current = computeUniformCaptionMetrics(ctx, segs, transcriptText);
        }
        const { size: CAP_SIZE, lineHeight: CAP_LH } = capMetricsMemoRef.current;
        
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `bold ${CAP_SIZE}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;
        
        const lines = wrapCaption(ctx, currentSeg.text, maxWidth).slice(0, MAX_LINES);
        const blockH = (lines.length - 1) * CAP_LH;
        const startY = (capH - blockH) / 2;
        
        for (let i = 0; i < lines.length; i++) {
          const y = startY + i * CAP_LH;
          ctx.fillText(lines[i], capX + capW / 2, y);
        }
        
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
    } else {
      // LEGACY MODE: Original AudioGraffiti layout
      const left = WIDTH * 0.06, right = WIDTH * 0.94;
      const availW = right - left, gap = 10;
      const bins = Math.min(64, bars?.length || 64);
      const barW = (availW - (bins - 1) * gap) / bins;
      const maxBarH = 150;
      const midY = CAP_TOP - 120;
      
      // Artwork rendering
      const artTop = 120;
      const artBottom = midY - maxBarH / 2 - 60;
      const artHeight = Math.max(0, artBottom - artTop);

      if (art && artHeight > 40) {
        drawImageCoverRounded(ctx, art, left, artTop, availW, artHeight, 28, artOp);
      }

      // Waveform bars
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

      // Captions with proper timing
      const idx = segmentIndexAtTime(segs, t);
      const raw = idx === -1 ? '' : (segs[idx]?.text || transcriptText || 'Record or upload audio').trim();

      if (raw) {
        const maxWidth = WIDTH * 0.94;
        if (!capMetricsMemoRef.current) {
          capMetricsMemoRef.current = computeUniformCaptionMetrics(ctx, segs, transcriptText);
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
    }
    
    // Watermark
    if (plan === 'free') {
      ctx.save();
      const wmHeight = Math.round(HEIGHT * 0.06);
      const wmWidth = Math.round(WIDTH * 0.6);
      const wmX = WIDTH - wmWidth - 10;
      const wmY = HEIGHT * 0.05;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      roundedRectFill(ctx, wmX, wmY, wmWidth, wmHeight, 8);
      const watermarkText = 'Scenaryoze.com';
      const fontSize = Math.round(wmHeight * 0.4);
      ctx.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.fillStyle = '#F4D03F';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(watermarkText, wmX + wmWidth / 2, wmY + wmHeight / 2);
      ctx.restore();
    }
  }

  async function renderWebMBlob(onProgress) {
    if (!audioUrl) throw new Error('No audio.');
    const a = new Audio(audioUrl);
    a.crossOrigin = 'anonymous';
    a.preload = 'auto';
    await new Promise((res, rej) => {
      a.addEventListener('canplay', res, { once: true });
      a.addEventListener('error', rej, { once: true });
      a.load();
    });
    const totalDuration = a.duration;
    if (!totalDuration || !isFinite(totalDuration)) throw new Error('Could not determine audio duration.');

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

    const videoStream = off.captureStream(FPS);
    const mixed = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickRecorderMime();
    
    // Add bitrate limits to keep file size reasonable (under 100MB for most videos)
    const recorderOptions = {
      mimeType: mime,
      videoBitsPerSecond: 3000000,  // 3 Mbps video = good quality, small file
      audioBitsPerSecond: 128000     // 128 kbps audio = standard quality
    };
    
    const rec = mime ? new MediaRecorder(mixed, recorderOptions) : new MediaRecorder(mixed);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    
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

    let segs = segments.length ? segments : [{ start: 0, end: totalDuration, text: transcript || '' }];
    
    // Map segments to speakers for character switching
    if (detectedCharacters.length > 0) {
      segs = mapSegmentsToSpeakers(segs, ttsText, speakerTimingsRef.current);
    }
    
    rec.start();
    a.currentTime = 0;
    await ac.resume();
    // Add 200ms delay before starting audio to prevent glitch
    await new Promise(resolve => setTimeout(resolve, 200));
    await a.play();

    let raf = 0;
    let fallbackInterval = null;
    
    const tick = () => {
      const currentTime = a.currentTime || 0;
      const b = computeBars();
      const grad = autoBg ? gradientAtTime(currentTime, totalDuration, presetIdx) : PRESETS[presetIdx];
      const slide = slideForTime(currentTime, totalDuration, artworks.map((x) => ({ img: x.img })));
      
      // Always render with 'free' plan for launch consistency
      drawFrame(ctx, currentTime, grad, segs, transcript, b, slide, artOpacity, 'free', customBrandingText);

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
    if (webm.size < 1024) throw new Error('Captured video is empty; please record longer audio.');
    return webm;
  }

  const exportMP4 = async () => {
    let exportLock = null;
    try {
      if (exportSupported === false) {
        setErr('Export not supported in this browser. Try desktop Chrome/Edge/Firefox.');
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
      if (!r.ok) {
        let msg = `HTTP ${r.status} ${r.statusText}`;
        try {
          const payload = await r.json();
          msg = payload?.error || (payload.stderrTail ? `ffmpeg: ${payload.stderrTail}` : msg);
        } catch {}
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

  return (
    <div className="min-h-dvh w-full bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,.9),#000)] text-white flex items-center justify-center p-4">
      <div className="w-[900px] max-w-[95vw] rounded-2xl bg-white/5 backdrop-blur-sm shadow-2xl border border-white/10 p-6">
        <div className="mb-4">
          <div className="text-xl font-bold text-white text-center">Scenaryoze</div>
        </div>

        {exportSupported === false && (
          <div className="mb-4 rounded-lg border border-yellow-400/40 bg-yellow-500/10 text-yellow-100 p-3 text-sm">
            <div className="font-medium">Export not supported in this browser.</div>
            <div className="mt-1 opacity-80">Please use <b>desktop Chrome, Edge, or Firefox</b>.</div>
            {exportReason && <div className="mt-1 opacity-60 text-xs">{exportReason}</div>}
          </div>
        )}

        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">
            Character Images
          </div>
          
          
            <div className="space-y-3">
              {detectedCharacters.length > 2 && (
                <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-400/30 rounded-lg p-2">
                  ⚠️ Scenaryoze supports max 2 characters. Using first 2.
                </div>
              )}
              {detectedCharacters.map((character, idx) => (
                <div key={character} className="p-3 rounded-lg bg-black/20 border border-white/10">
                  <div className="flex items-start gap-3">
                    {/* Character Image Preview */}
                    <div className="relative h-16 w-16 rounded-md overflow-hidden border border-white/20 flex-shrink-0">
                      {characterImages[character] ? (
                        <img 
                          src={characterImages[character].url} 
                          alt={character} 
                          className="h-full w-full object-cover" 
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center bg-gray-700 text-white text-xs">
                          Loading...
                        </div>
                      )}
                    </div>
                    
                    {/* Character Info */}
                    <div className="flex-1 space-y-1">
                      <div className="font-medium text-white/90">{character}</div>
                      <div className="text-xs text-white/60">
                        Voice: {VOICE_THEMES[characterVoices[character]]?.name || characterVoices[character]}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
        </div>

        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">
            Character Script
            <span className="ml-2 text-xs text-white/50 font-normal">
              (Format: [NAME]:, NAME:, or **NAME:** dialogue)
            </span>
          </div>
          <textarea 
            value={ttsText} 
            onChange={(e) => setTtsText(e.target.value)} 
            rows={8} 
            className="w-full rounded-lg bg-white/10 border border-white/15 p-3 text-sm text-white placeholder-white/50 resize-none font-mono" 
            placeholder="[SHAWN]: Welcome to the helpdesk, how can I help you?&#10;[BRITTANY]: I can't access my email account.&#10;[SHAWN]: Let me check your account status first."
            maxLength={PLAN_LIMITS[userPlan].maxChars} 
          />
          <div className="flex items-center gap-2 mt-2">
            <button onClick={generateTTS} disabled={isTtsBusy || !ttsText.trim() || ttsText.trim().length > PLAN_LIMITS[userPlan].maxChars || detectedCharacters.length === 0} className="px-4 py-2 rounded-lg text-sm bg-green-500/90 hover:bg-green-500 text-black border border-green-300 font-medium disabled:opacity-60 disabled:cursor-not-allowed">
              {isTtsBusy ? 'Generating Audio…' : 'Generate Audio'}
            </button>
            <div className="text-xs ml-auto">
              <div className={`${ttsText.trim().length > PLAN_LIMITS[userPlan].maxChars ? 'text-red-400' : 'text-white/60'}`}>
                {ttsText.trim().length} / {PLAN_LIMITS[userPlan].maxChars}
              </div>
              <div className="text-white/50 text-[10px]">{userPlan} limit</div>
            </div>
          </div>
        </div>

        <div className="mb-4">
          <div className="text-sm font-medium mb-2 text-white/90">Background</div>
          <div className="flex gap-2 items-center">
            {PRESETS.map((g, i) => (
              <button key={i} onClick={() => setPresetIdx(i)} className={`h-6 w-8 rounded-md border transition-all ${presetIdx === i ? 'border-white/80 scale-110' : 'border-white/20 hover:border-white/40'}`} style={{ background: `linear-gradient(180deg, ${g[0]}, ${g[1]})` }} />
            ))}
            <div className="flex items-center gap-2 ml-auto text-xs text-white/80">
              <span>Auto</span>
              <button onClick={() => setAutoBg((v) => !v)} className={`px-2 py-1 rounded transition-colors ${autoBg ? 'bg-yellow-500/90 text-black font-medium' : 'bg-white/15 hover:bg-white/25 text-white/90'}`}>
                {autoBg ? 'On' : 'Off'}
              </button>
            </div>
          </div>
        </div>

        <div className="mb-4">
          <button onClick={exportMP4} disabled={isExporting || exportSupported === false || !segments.length} className="w-full px-4 py-3 rounded-lg bg-green-500/90 hover:bg-green-500 text-black text-lg font-bold disabled:opacity-60 disabled:cursor-not-allowed border border-green-300" title={!segments.length ? 'Transcribe audio first' : undefined}>
            Export MP4 Video
          </button>
          {isExporting && (
            <div className="mt-2 text-sm text-white/70 text-center">
              {phase === 'render' ? `Rendering… ${renderPct}%` : 'Encoding on server… (can take a minute)'}
            </div>
          )}
        </div>

        <div className="p-3 rounded-lg bg-black/20 border border-white/10">
          <audio ref={audioRef} src={audioUrl || undefined} controls playsInline preload="auto" className="w-full mb-2" />
          <div className="flex justify-between text-xs text-white/60">
            <div>Segments: {segments.length}</div>
            <div>Current: {segments.length ? `${Math.min(currentIdx + 1, segments.length)}/${segments.length}` : '—'}</div>
          </div>
        </div>

        {err && (
          <div className="mt-3 text-sm text-red-300 bg-red-900/30 rounded-lg p-3 border border-red-400/30 whitespace-pre-wrap">
            {err}
          </div>
        )}
      </div>
    </div>
  );
}