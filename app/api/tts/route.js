// app/api/tts/route.js
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 minute for multi-voice generation

/* ------------------ CONFIG ------------------ */
const DEFAULT_MODEL = (process.env.TTS_MODEL || "tts-1").trim();
const DEFAULT_FORMAT = "mp3"; // Use MP3 for easier concatenation
const DEFAULT_VOICE = (process.env.TTS_DEFAULT_VOICE || "brittany").trim();

// Production-safe cache and temp directories
const CACHE_DIR =
  (process.env.TTS_CACHE_DIR?.trim()) ||
  path.join(process.env.NODE_ENV === 'production' ? '/tmp' : process.cwd(), 
           process.env.NODE_ENV === 'production' ? 'tts-cache' : '.next/tts-cache');

const TEMP_DIR = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(process.cwd(), '.next', 'temp');

const TTL_HOURS = Number(process.env.TTS_CACHE_TTL_HOURS || 720); // 30 days
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('⚠️  OPENAI_API_KEY environment variable is required');
}

/* ------------------ CLIENT ------------------ */
const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  timeout: 30000,
});
// ElevenLabs Configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_API_KEY) {
  console.error('⚠️  ELEVENLABS_API_KEY environment variable is required');
}

// Map character voice names to ElevenLabs voice IDs
const ELEVENLABS_VOICE_MAP = {
  'shawn': 'UGTtbzgh3HObxRjWaSpr',    // Brian
  'chuck': 'tFNXkg45n3yC6nHvEn2s',    // New Chuck Voice
  'max': 'NFG5qt843uXKj4pFvR7C',      // Adam Stone
  'boomer': 'MZb4jD8N3GIedB0K3Xoi',   // New Boomer Voice
  'brittany': '5l5f8iK3YPeGga21rQIX', // Adeline
  'kaitlyn': 'ZT9u07TYPVl83ejeLakq',  // Rachel
  'sage': '9q9xpGHwmkXdA4JI72IU',     // Kaylin
  'randy': 'a5buv0aPWw8Gjhq3BKgi',    // Ryan
  'coral': 'aUNOP2y8xEvi4nZebjIw'     // Nicole
};

/* ------------------ ELEVENLABS TTS ------------------ */
async function generateElevenLabsTTS(text, voiceId) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/* ------------------ UTILS ------------------ */
function mimeFrom(format) {
  switch ((format || "").toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    default:    return "application/octet-stream";
  }
}

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
  return createHash('md5').update(Date.now() + Math.random().toString()).digest('hex').slice(0, 12);
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

function getModelForPlan(plan) {
  return plan === 'pro' ? 'tts-1-hd' : DEFAULT_MODEL;
}

/* ------------------ VALIDATION ------------------ */
function validateTTSRequest(payload) {
  const errors = [];
  
  if (!payload || typeof payload !== 'object') {
    errors.push('Request body must be a JSON object');
  }
  
  // Check if this is multi-voice request
  const hasSegments = Array.isArray(payload.segments);
  
  if (hasSegments) {
    // Multi-voice validation
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
      
      // Check each segment individually (OpenAI limit is 4096 per request)
      if (normalized.length > 4096) {
        errors.push(`Segment text exceeds 4096 characters`);
        break;
      }
      
      const voice = (segment.voice || DEFAULT_VOICE).trim();
      const validVoices = ['shawn', 'chuck', 'max', 'boomer', 'brittany', 'kaitlyn', 'sage', 'randy', 'coral'];
      if (!validVoices.includes(voice)) {
        errors.push(`Invalid voice in segment: ${voice}. Must be one of: ${validVoices.join(', ')}`);
        break;
      }
    }
    
    return { errors, isMultiVoice: true, segments: payload.segments };
  } else {
    // Single voice validation (backward compatible)
    const text = normalizeSpaces(payload.text || '');
    if (!text) {
      errors.push('Text parameter is required and cannot be empty');
    }
    
    if (text.length > 4096) {
      errors.push('Text cannot exceed 4096 characters');
    }
    
    const voice = (payload.voice || DEFAULT_VOICE).trim();
    const validVoices = ['shawn', 'chuck', 'max', 'boomer', 'brittany', 'kaitlyn', 'sage', 'randy', 'coral'];
    if (!validVoices.includes(voice)) {
      errors.push(`Voice must be one of: ${validVoices.join(', ')}`);
    }
    
    const format = (payload.format || DEFAULT_FORMAT).toLowerCase();
    if (!['mp3', 'wav', 'ogg'].includes(format)) {
      errors.push('Format must be one of: mp3, wav, ogg');
    }
    
    return { errors, isMultiVoice: false, text, voice, format };
  }
}

/* ------------------ SILENCE GENERATION (NEW) ------------------ */
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
      resolve({
        success: false,
        stderr: `Spawn error: ${error.message}`,
      });
    });
  });
}

/* ------------------ GET AUDIO DURATION ------------------ */
async function getAudioDuration(filePath) {
  const ffprobePath = process.env.NODE_ENV === 'production' ? 'ffprobe' : 'ffprobe';
  
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 0 : duration);
      } else {
        console.warn('ffprobe error:', stderr);
        resolve(0); // Return 0 on error rather than failing
      }
    });

    ffprobe.on('error', (error) => {
      console.warn('ffprobe spawn error:', error);
      resolve(0);
    });
  });
}
/* ------------------ FFMPEG AUDIO CONCATENATION ------------------ */
async function concatenateAudioFiles(inputFiles, outputPath) {
  const ffmpegPath = findFFmpegPath();
  
  return new Promise((resolve) => {
    // Create concat filter
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

      resolve({
        success,
        stderr: stderr.slice(-500),
      });
    });

    ffmpeg.on('error', (error) => {
      console.error('FFmpeg spawn error:', error);
      resolve({
        success: false,
        stderr: `Spawn error: ${error.message}`,
      });
    });
  });
}

/* ------------------ MULTI-VOICE GENERATION (UPDATED) ------------------ */
async function generateMultiVoiceAudio(segments, model) {
  const tempId = generateTempId();
  await ensureDir(TEMP_DIR);
  
  const tempFiles = [];
  const outputPath = path.join(TEMP_DIR, `multivoice_${tempId}.mp3`);
  
  try {
    // Generate TTS for each segment
    console.log(`Generating ${segments.length} voice segments`);
    
    
    // Track timing for each speaker segment
    const speakerTimings = [];
    let cumulativeTime = 0;
    
    // Add 0.2s silence at the very start to prevent initial audio "tick"
    const initialSilenceFile = path.join(TEMP_DIR, `initial_silence_${tempId}.mp3`);
    const initialSilenceResult = await generateSilenceFile(initialSilenceFile, 0.2);
    
    if (initialSilenceResult.success) {
      tempFiles.push(initialSilenceFile);
      console.log('Added 0.2s initial silence to prevent audio tick');
    }
      cumulativeTime += 0.2; // Track initial silence
    
    
    let lastVoice = null; // Track previous voice for pause detection
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const text = normalizeSpaces(segment.text);
      const voice = (segment.voice || DEFAULT_VOICE).trim();
      
      // ✅ NEW: Add 1.0s pause when voice changes (except first segment)
      if (i > 0 && lastVoice && lastVoice !== voice) {
        console.log(`Adding 1.0s pause between ${lastVoice} and ${voice}`);
        
        const pauseFile = path.join(TEMP_DIR, `pause_${tempId}_${i}.mp3`);
        const pauseResult = await generateSilenceFile(pauseFile, 1.0);
        
        if (pauseResult.success) {
          tempFiles.push(pauseFile);
          cumulativeTime += 1.0; // Track pause between speakers
        } else {
          console.warn('Failed to generate pause, continuing without it');
        }
      }
      
      // Map voice name to ElevenLabs voice ID
      const voiceId = ELEVENLABS_VOICE_MAP[voice.toLowerCase()];
      if (!voiceId) {
        throw new Error(`Unknown voice: ${voice}. Valid voices: ${Object.keys(ELEVENLABS_VOICE_MAP).join(', ')}`);
      }
      
      console.log(`Segment ${i + 1}/${segments.length}: ${voice} (${voiceId}) - "${text.substring(0, 30)}..."`);
      
      // Generate TTS using ElevenLabs
      const audio = await generateElevenLabsTTS(text, voiceId);
      
      if (audio.length < 100) {
        throw new Error(`Segment ${i + 1} generated suspiciously small audio`);
      }
      
      const tempFile = path.join(TEMP_DIR, `segment_${tempId}_${i}.mp3`);
      await fs.writeFile(tempFile, audio);
      tempFiles.push(tempFile);
      
      console.log(`Segment ${i + 1} generated: ${audio.length} bytes`);
      
      lastVoice = voice; // Track for next iteration
    }
    
    // Concatenate all segments (including pauses)
    console.log(`Concatenating ${tempFiles.length} files (${segments.length} segments + pauses)`);
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
    
    return { audio: finalAudio, timings: speakerTimings };
    
  } finally {
    // Cleanup temp files
    for (const file of tempFiles) {
      await cleanupFile(file);
    }
    await cleanupFile(outputPath);
  }
}

/* ------------------ SINGLE VOICE GENERATION (ORIGINAL) ------------------ */
async function generateSingleVoiceAudio(text, voice, format, model, bypass, userId) {
  const key = sha256([userId, model, voice, format, text].join(":"));
  const filePath = shardPath(CACHE_DIR, key, format);

  // Try cache first (unless bypassed)
  if (!bypass) {
    const hit = await readFreshFileIfAny(filePath);
    if (hit) {
      console.log('Cache hit for single-voice TTS');
      return { audio: hit, cached: true };
    }
  }

  // Generate TTS
  console.log(`Generating single-voice TTS using ${model}`);
  
  const response = await openai.audio.speech.create({
    model,
    voice: voice,
    input: text,
    response_format: format,
  });

  const audio = Buffer.from(await response.arrayBuffer());

  if (audio.length < 100) {
    throw new Error('Generated audio file is suspiciously small');
  }

  // Cache the result
  await writeCacheFile(filePath, audio);

  return { audio, cached: false };
}

/* ------------------ HANDLER ------------------ */
export async function POST(req) {
  const startTime = Date.now();
  
  try {
    // Environment check
    if (!OPENAI_API_KEY) {
      console.error('TTS API called without OpenAI API key configured');
      return NextResponse.json(
        { error: "TTS service is not properly configured" },
        { status: 500 }
      );
    }

    // Parse and validate request
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

    // Extract user identification and plan
    const userId = (payload.userId || req.headers.get("x-user-id") || "anon").toString();
    const userPlan = validateUserPlan(payload.userPlan);
    const model = getModelForPlan(userPlan);
    
    const bypass =
      !!payload.bypassCache ||
      req.nextUrl.searchParams.get("bypass") === "1" ||
      req.headers.get("x-bypass-cache") === "1";

    let audio;
    let speakerTimings = null;
    let cached = false;
    const format = validation.isMultiVoice ? 'mp3' : (validation.format || DEFAULT_FORMAT);

    if (validation.isMultiVoice) {
      // MULTI-VOICE MODE
      console.log(`Multi-voice TTS request: ${validation.segments.length} segments`);
      const result = await generateMultiVoiceAudio(validation.segments, model);
      audio = result.audio;
      speakerTimings = result.timings; // Capture timing data
      cached = false; // Multi-voice not cached (for now)
    } else {
      // SINGLE VOICE MODE (backward compatible)
      const result = await generateSingleVoiceAudio(
        validation.text,
        validation.voice,
        format,
        model,
        bypass,
        userId
      );
      audio = result.audio;
      cached = result.cached;
    }

    const generationTime = Date.now() - startTime;
    console.log(`TTS completed: ${audio.length} bytes in ${generationTime}ms (${userPlan}/${model})`);

    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": mimeFrom(format),
        "Cache-Control": "public, max-age=3600",
        "X-Cache-Hit": cached ? "1" : "0",
        "X-TTS-Model": model,
        "X-User-Plan": userPlan,
        "X-Generation-Time": generationTime.toString(),
        "X-Multi-Voice": validation.isMultiVoice ? "1" : "0",
        ...(speakerTimings ? { "X-Speaker-Timings": JSON.stringify(speakerTimings) } : {}),
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