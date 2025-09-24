// app/api/tts/route.js
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------ CONFIG ------------------ */
const DEFAULT_MODEL = (process.env.TTS_MODEL || "tts-1").trim();        // default TTS model
const DEFAULT_FORMAT = "wav";
const DEFAULT_VOICE = (process.env.TTS_DEFAULT_VOICE || "nova").trim();

// Production-safe cache directory
const CACHE_DIR =
  (process.env.TTS_CACHE_DIR?.trim()) ||
  path.join(process.env.NODE_ENV === 'production' ? '/tmp' : process.cwd(), 
           process.env.NODE_ENV === 'production' ? 'tts-cache' : '.next/tts-cache');

const TTL_HOURS = Number(process.env.TTS_CACHE_TTL_HOURS || 720); // 30 days
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

// Production environment validation
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('⚠️  OPENAI_API_KEY environment variable is required');
}

/* ------------------ CLIENT ------------------ */
const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  timeout: 30000, // 30 second timeout for production stability
});

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

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    // In production, log but don't fail if cache directory creation fails
    console.warn('Cache directory creation failed:', error);
  }
}

async function readFreshFileIfAny(p) {
  try {
    const st = await fs.stat(p);
    const age = Date.now() - st.mtimeMs;
    if (age <= TTL_MS && st.size > 0) {
      return await fs.readFile(p);
    }
  } catch {
    // File doesn't exist or is unreadable
  }
  return null;
}

async function writeCacheFile(filePath, data) {
  try {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, data);
  } catch (error) {
    // Log but don't fail if cache write fails
    console.warn('Cache write failed:', error);
  }
}

/* ------------------ PLAN VALIDATION ------------------ */
function validateUserPlan(plan) {
  if (typeof plan === 'string' && (plan === 'free' || plan === 'pro')) {
    return plan;
  }
  // Default to free for any invalid input
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
  
  const text = normalizeSpaces(payload.text || '');
  if (!text) {
    errors.push('Text parameter is required and cannot be empty');
  }
  
  if (text.length > 4096) {
    errors.push('Text cannot exceed 4096 characters');
  }
  
  const voice = (payload.voice || DEFAULT_VOICE).trim();
  const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'coral', 'sage'];
  if (!validVoices.includes(voice)) {
    errors.push(`Voice must be one of: ${validVoices.join(', ')}`);
  }
  
  const format = (payload.format || DEFAULT_FORMAT).toLowerCase();
  if (!['mp3', 'wav', 'ogg'].includes(format)) {
    errors.push('Format must be one of: mp3, wav, ogg');
  }
  
  return { errors, text, voice, format };
}

/* ------------------ HANDLER ------------------ */
export async function POST(req) {
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

    const { errors, text, voice, format } = validateTTSRequest(payload);
    if (errors.length > 0) {
      return NextResponse.json(
        { error: errors.join('; ') },
        { status: 400 }
      );
    }

    // Extract user identification and plan
    const userId = (payload.userId || req.headers.get("x-user-id") || "anon").toString();
    const userPlan = validateUserPlan(payload.userPlan);
    
    const bypass =
      !!payload.bypassCache ||
      req.nextUrl.searchParams.get("bypass") === "1" ||
      req.headers.get("x-bypass-cache") === "1";

    // Select model based on user plan
    const model = getModelForPlan(userPlan);

    // Generate cache key that includes model for separate caching
    const key = sha256([userId, model, voice, format, text].join(":"));
    const filePath = shardPath(CACHE_DIR, key, format);

    // Try cache first (unless bypassed)
    if (!bypass) {
      const hit = await readFreshFileIfAny(filePath);
      if (hit) {
        return new NextResponse(hit, {
          status: 200,
          headers: {
            "Content-Type": mimeFrom(format),
            "Cache-Control": "public, max-age=3600", // 1 hour browser cache
            "X-Cache-Hit": "1",
            "X-TTS-Model": model,
            "X-User-Plan": userPlan,
          },
        });
      }
    }

    // Generate TTS with plan-appropriate model
    console.log(`Generating TTS: ${userPlan} plan using ${model}`);
    
    const startTime = Date.now();
    const response = await openai.audio.speech.create({
      model,              // "tts-1" for free, "tts-1-hd" for pro
      voice: voice,
      input: text,
      response_format: format,
    });

    const audio = Buffer.from(await response.arrayBuffer());
    const generationTime = Date.now() - startTime;

    // Validate generated audio
    if (audio.length < 100) {
      throw new Error('Generated audio file is suspiciously small');
    }

    // Cache the result (best effort)
    await writeCacheFile(filePath, audio);

    // Log successful generation for monitoring
    console.log(`TTS generated successfully: ${audio.length} bytes in ${generationTime}ms (${userPlan}/${model})`);

    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": mimeFrom(format),
        "Cache-Control": "public, max-age=3600", // 1 hour browser cache
        "X-Cache-Hit": "0",
        "X-TTS-Model": model,
        "X-User-Plan": userPlan,
        "X-Generation-Time": generationTime.toString(),
      },
    });

  } catch (error) {
    // Enhanced error logging for production debugging
    console.error('TTS generation failed:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });

    // Provide user-friendly error messages
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