// app/api/tts/route.js
// Scenaryoze - Fish Audio TTS (Single Provider)
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ------------------ CONFIG ------------------ */
const DEFAULT_FORMAT = "mp3";
const DEFAULT_VOICE = "brittany";

const CACHE_DIR =
  (process.env.TTS_CACHE_DIR?.trim()) ||
  path.join(process.env.NODE_ENV === 'production' ? '/tmp' : process.cwd(), 
           process.env.NODE_ENV === 'production' ? 'tts-cache' : '.next/tts-cache');

const TEMP_DIR = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(process.cwd(), '.next', 'temp');

const TTL_HOURS = Number(process.env.TTS_CACHE_TTL_HOURS || 720);
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

// Fish Audio API Configuration
const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY;
if (!FISH_AUDIO_API_KEY) {
  console.error('⚠️  FISH_AUDIO_API_KEY environment variable is required');
}

// Map character voice names to Fish Audio voice IDs
const FISH_AUDIO_VOICE_MAP = {
  'shawn': '536d3a5e000945adb7038665781a4aca',      // Ethan
  'chuck': 'ccbc13d6002a46b7883f607fd8fe0516',      // Black Man
  'max': '37a48fabcd8241ab9b69d8675fb1fe13',        // Brian
  'boomer': 'ba24f05b17644498adb77243afd11dd9',     // Mild Manager
  'randy': 'bf322df2096a46f18c579d0baa36f41d',      // Adrian
  'brittany': '2a9605eeafe84974b5b20628d42c0060',   // Female Voice
  'kaitlyn': 'da8ae28bb18d4a1ca55eccf096f4c8da',    // Black Woman
  'sage': '933563129e564b19a115bedd57b7406a',       // Sarah
  'coral': 'e107ce68d2a64e928c3a674781ce9d56'       // Upbeat Woman
};

const PLAN_LIMITS = {
  free: { maxChars: 50000, displayName: 'Free' },
  pro: { maxChars: 50000, displayName: 'Pro' }
};

/* ------------------ CHARACTER TAG STRIPPING ------------------ */
function stripCharacterTags(text) {
  // Remove character tags like [SHAWN]:, **BRITTANY:**, etc.
  // This allows Fish Audio to see emotion tags at the beginning of the sentence
  return text.replace(/^\s*\*?\*?\[?[A-Z][A-Z\s\-]*\]?\*?\*?:\s*/i, '').trim();
}

/* ------------------ FISH AUDIO TTS ------------------ */
async function generateFishAudioTTS(text, voiceId) {
  // Strip character tags before sending to Fish Audio
  const cleanText = stripCharacterTags(text);
  
  console.log(`Calling Fish Audio API with voice ${voiceId}`);
  console.log(`Original text: "${text.substring(0, 100)}..."`);
  console.log(`Cleaned text: "${cleanText.substring(0, 100)}..."`);
  
  const url = 'https://api.fish.audio/v1/tts';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: cleanText,       // Send cleaned text WITHOUT character tags
      reference_id: voiceId,
      model: 's1',           // Use Fish Audio S1 for emotion support
      format: 'mp3',
      normalize: false,      // CRITICAL: Preserve emotion tags!
      latency: 'normal'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Fish Audio API error: ${response.status} - ${errorText}`);
    throw new Error(`Fish Audio API error: ${response.status}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  console.log(`Fish Audio generated ${audioBuffer.length} bytes`);
  
  return audioBuffer;
}

/* ------------------ UTILS ------------------ */
function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function shardPath(root, hash, ext) {
  const a = hash.slice(0, 2) || "00";
  const b = hash.slice(2, 4) || "00";
  return path.join(root, a, b, `${hash}.${ext}`);
}

function generateTempId() {
  return createHash('md5')
    .update(Date.now() + Math.random().toString())
    .digest('hex')
    .slice(0, 12);
}

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    console.warn('Directory creation failed:', error);
  }
}

async function readFreshFileIfAny(p) {
  try {
    const st = await fs.stat(p);
    const age = Date.now() - st.mtimeMs;
    if (age <= TTL_MS && st.size > 0) {
      return await fs.readFile(p);
    }
  } catch {}
  return null;
}

async function writeCacheFile(filePath, data) {
  try {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, data);
  } catch (error) {
    console.warn('Cache write failed:', error);
  }
}

async function cleanupFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    console.warn('File cleanup failed:', filePath);
  }
}

function findFFmpegPath() {
  return process.env.NODE_ENV === 'production' ? 'ffmpeg' : 'ffmpeg';
}

/* ------------------ PLAN VALIDATION ------------------ */
function validateUserPlan(plan) {
  if (typeof plan === 'string' && (plan === 'free' || plan === 'pro')) {
    return plan;
  }
  return 'free';
}

/* ------------------ VALIDATION ------------------ */
function validateTTSRequest(payload) {
  const errors = [];
  
  if (!payload || typeof payload !== 'object') {
    errors.push('Request body must be a JSON object');
  }
  
  const hasSegments = Array.isArray(payload.segments);
  
  if (hasSegments) {
    if (payload.segments.length === 0) {
      errors.push('Segments array cannot be empty');
    }
    
    if (payload.segments.length > 50) {
      errors.push('Maximum 50 segments allowed');
    }
    
    for (const segment of payload.segments) {
      if (!segment.text || typeof segment.text !== 'string') {
        errors.push('Each segment must have a text property');
        break;
      }
      const normalized = normalizeSpaces(segment.text);
      if (!normalized) {
        errors.push('Segment text cannot be empty');
        break;
      }
      
      if (normalized.length > 4096) {
        errors.push(`Segment text exceeds 4096 characters`);
        break;
      }
      
      const voice = (segment.voice || DEFAULT_VOICE).trim();
      const validVoices = Object.keys(FISH_AUDIO_VOICE_MAP);
      if (!validVoices.includes(voice)) {
        errors.push(`Invalid voice in segment: ${voice}. Must be one of: ${validVoices.join(', ')}`);
        break;
      }
    }
    
    return { errors, isMultiVoice: true, segments: payload.segments };
  } else {
    const text = normalizeSpaces(payload.text || '');
    if (!text) {
      errors.push('Text parameter is required and cannot be empty');
    }
    
    if (text.length > 4096) {
      errors.push('Text cannot exceed 4096 characters');
    }
    
    const voice = (payload.voice || DEFAULT_VOICE).trim();
    const validVoices = Object.keys(FISH_AUDIO_VOICE_MAP);
    if (!validVoices.includes(voice)) {
      errors.push(`Voice must be one of: ${validVoices.join(', ')}`);
    }
    
    const format = (payload.format || DEFAULT_FORMAT).toLowerCase();
    if (!['mp3'].includes(format)) {
      errors.push('Format must be mp3');
    }
    
    return { errors, isMultiVoice: false, text, voice, format };
  }
}

/* ------------------ SILENCE GENERATION ------------------ */
async function generateSilenceFile(outputPath, durationSeconds) {
  const ffmpegPath = findFFmpegPath();
  
  return new Promise((resolve) => {
    const args = [
      '-f', 'lavfi',
      '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', durationSeconds.toString(),
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      const success = code === 0;
      if (success) {
        console.log(`Generated ${durationSeconds}s silence file`);
      } else {
        console.error('Silence generation failed:', stderr.slice(-500));
      }
      resolve({ success, stderr: stderr.slice(-500) });
    });

    ffmpeg.on('error', (error) => {
      console.error('FFmpeg spawn error during silence generation:', error);
      resolve({ success: false, stderr: `Spawn error: ${error.message}` });
    });
  });
}

/* ------------------ AUDIO CONCATENATION ------------------ */
async function concatenateAudioFiles(inputFiles, outputPath) {
  const ffmpegPath = findFFmpegPath();
  
  return new Promise((resolve) => {
    const inputs = [];
    const filterComplex = [];
    
    inputFiles.forEach((file, i) => {
      inputs.push('-i', file);
      filterComplex.push(`[${i}:a]`);
    });
    
    const concatFilter = `${filterComplex.join('')}concat=n=${inputFiles.length}:v=0:a=1[temp];[temp]afade=t=in:st=0:d=0.1[outa]`;
    
    const args = [
      ...inputs,
      '-filter_complex', concatFilter,
      '-map', '[outa]',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      '-y',
      outputPath
    ];

    console.log(`Concatenating ${inputFiles.length} audio files with FFmpeg`);
    
    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      const success = code === 0;
      
      if (success) {
        console.log('Audio concatenation completed successfully');
      } else {
        console.error('Audio concatenation failed with code:', code);
        console.error('FFmpeg stderr:', stderr.slice(-500));
      }

      resolve({ success, stderr: stderr.slice(-500) });
    });

    ffmpeg.on('error', (error) => {
      console.error('FFmpeg spawn error:', error);
      resolve({ success: false, stderr: `Spawn error: ${error.message}` });
    });
  });
}

/* ------------------ MULTI-VOICE GENERATION ------------------ */
async function generateMultiVoiceAudio(segments) {
  const tempId = generateTempId();
  await ensureDir(TEMP_DIR);
  
  const tempFiles = [];
  const outputPath = path.join(TEMP_DIR, `multivoice_${tempId}.mp3`);
  
  try {
    console.log(`Generating ${segments.length} voice segments with Fish Audio`);
    
    // Add 0.2s initial silence to prevent audio click
    const initialSilenceFile = path.join(TEMP_DIR, `initial_silence_${tempId}.mp3`);
    const initialSilenceResult = await generateSilenceFile(initialSilenceFile, 0.2);
    
    if (initialSilenceResult.success) {
      tempFiles.push(initialSilenceFile);
      console.log('Added 0.2s initial silence to prevent audio tick');
    }
    
    let lastVoice = null;
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const text = normalizeSpaces(segment.text);
      const voice = (segment.voice || DEFAULT_VOICE).trim();
      
      // Add 1.0s pause when voice changes
      if (i > 0 && lastVoice && lastVoice !== voice) {
        console.log(`Adding 0.3s pause between ${lastVoice} and ${voice}`);
        
        const pauseFile = path.join(TEMP_DIR, `pause_${tempId}_${i}.mp3`);
        const pauseResult = await generateSilenceFile(pauseFile, 0.3);
        
        if (pauseResult.success) {
          tempFiles.push(pauseFile);
        } else {
          console.warn('Failed to generate pause, continuing without it');
        }
      }
      
      // Map voice name to Fish Audio voice ID
      const voiceId = FISH_AUDIO_VOICE_MAP[voice.toLowerCase()];
      if (!voiceId) {
        throw new Error(`Unknown voice: ${voice}. Valid voices: ${Object.keys(FISH_AUDIO_VOICE_MAP).join(', ')}`);
      }
      
      console.log(`Segment ${i + 1}/${segments.length}: ${voice} - "${text.substring(0, 50)}..."`);
      
      // Generate TTS using Fish Audio - text includes emotion tags
      const audio = await generateFishAudioTTS(text, voiceId);
      
      if (audio.length < 100) {
        throw new Error(`Segment ${i + 1} generated suspiciously small audio`);
      }
      
      const tempFile = path.join(TEMP_DIR, `segment_${tempId}_${i}.mp3`);
      await fs.writeFile(tempFile, audio);
      tempFiles.push(tempFile);
      
      console.log(`Segment ${i + 1} generated: ${audio.length} bytes`);
      
      lastVoice = voice;
    }
    
    // Concatenate all segments
    console.log(`Concatenating ${tempFiles.length} files`);
    const concatResult = await concatenateAudioFiles(tempFiles, outputPath);
    
    if (!concatResult.success) {
      throw new Error(`Audio concatenation failed: ${concatResult.stderr}`);
    }
    
    // Read final audio
    const finalAudio = await fs.readFile(outputPath);
    
    if (finalAudio.length < 100) {
      throw new Error('Final concatenated audio is suspiciously small');
    }
    
    console.log(`Multi-voice audio generated successfully: ${finalAudio.length} bytes`);
    
    return { audio: finalAudio };
    
  } finally {
    // Cleanup temp files
    for (const file of tempFiles) {
      await cleanupFile(file);
    }
    await cleanupFile(outputPath);
  }
}

/* ------------------ SINGLE VOICE GENERATION ------------------ */
async function generateSingleVoiceAudio(text, voice, format, bypass, userId) {
  const key = sha256([userId, voice, format, text].join(":"));
  const filePath = shardPath(CACHE_DIR, key, format);

  // Try cache first (unless bypassed)
  if (!bypass) {
    const hit = await readFreshFileIfAny(filePath);
    if (hit) {
      console.log('Cache hit for single-voice TTS');
      return { audio: hit, cached: true };
    }
  }

  // Generate TTS with Fish Audio
  console.log(`Generating single-voice TTS with Fish Audio`);
  
  const voiceId = FISH_AUDIO_VOICE_MAP[voice];
  if (!voiceId) {
    throw new Error(`Unknown voice: ${voice}`);
  }
  
  const audio = await generateFishAudioTTS(text, voiceId);

  if (audio.length < 100) {
    throw new Error('Generated audio file is suspiciously small');
  }

  // Cache the result
  await writeCacheFile(filePath, audio);

  return { audio, cached: false };
}

/* ------------------ MAIN HANDLER ------------------ */
export async function POST(req) {
  const startTime = Date.now();
  
  try {
    if (!FISH_AUDIO_API_KEY) {
      console.error('TTS API called without Fish Audio API key configured');
      return NextResponse.json(
        { error: "TTS service is not properly configured" },
        { status: 500 }
      );
    }

    let payload;
    try {
      payload = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const validation = validateTTSRequest(payload);
    if (validation.errors.length > 0) {
      return NextResponse.json(
        { error: validation.errors.join('; ') },
        { status: 400 }
      );
    }

    const userId = (payload.userId || req.headers.get("x-user-id") || "anon").toString();
    const userPlan = validateUserPlan(payload.userPlan);
    
    const bypass =
      !!payload.bypassCache ||
      req.nextUrl.searchParams.get("bypass") === "1" ||
      req.headers.get("x-bypass-cache") === "1";

    let audio;
    let cached = false;
    const format = validation.isMultiVoice ? 'mp3' : (validation.format || DEFAULT_FORMAT);

    if (validation.isMultiVoice) {
      console.log(`Multi-voice TTS request: ${validation.segments.length} segments`);
      const result = await generateMultiVoiceAudio(validation.segments);
      audio = result.audio;
      cached = false;
    } else {
      const result = await generateSingleVoiceAudio(
        validation.text,
        validation.voice,
        format,
        bypass,
        userId
      );
      audio = result.audio;
      cached = result.cached;
    }

    const generationTime = Date.now() - startTime;
    console.log(`TTS completed: ${audio.length} bytes in ${generationTime}ms (${userPlan})`);

    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=3600",
        "X-Cache-Hit": cached ? "1" : "0",
        "X-TTS-Provider": "fish-audio",
        "X-User-Plan": userPlan,
        "X-Generation-Time": generationTime.toString(),
        "X-Multi-Voice": validation.isMultiVoice ? "1" : "0",
      },
    });

  } catch (error) {
    console.error('TTS generation failed:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });

    let userMessage = "TTS generation failed";
    let statusCode = 500;

    if (error.message?.includes('API key')) {
      userMessage = "TTS service configuration error";
      statusCode = 503;
    } else if (error.message?.includes('rate limit') || error.message?.includes('quota')) {
      userMessage = "TTS service is temporarily busy, please try again";
      statusCode = 429;
    } else if (error.message?.includes('timeout')) {
      userMessage = "TTS generation timed out, please try again";
      statusCode = 504;
    } else if (error.message?.includes('suspiciously small')) {
      userMessage = "Generated audio was invalid, please try different text";
      statusCode = 422;
    } else if (error.message?.includes('concatenation failed')) {
      userMessage = "Audio merging failed, please try again";
      statusCode = 500;
    }

    return NextResponse.json(
      { 
        error: userMessage,
        ...(process.env.NODE_ENV === 'development' && { 
          debug: error.message 
        })
      },
      { status: statusCode }
    );
  }
}