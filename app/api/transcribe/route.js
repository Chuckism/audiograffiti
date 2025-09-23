// app/api/transcribe/route.js
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 minute timeout for transcription

/* ------------------ CONFIG ------------------ */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB - OpenAI's limit
const SUPPORTED_FORMATS = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/m4a',
  'audio/mp4',
  'video/webm',
  'video/mp4'
];

// Environment validation
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('⚠️  OPENAI_API_KEY environment variable is required for transcription');
}

/* ------------------ CLIENT ------------------ */
const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  timeout: 45000, // 45 second timeout
});

/* ------------------ VALIDATION ------------------ */
function validateAudioFile(file) {
  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    return {
      isValid: false,
      error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`
    };
  }

  // Check minimum file size
  if (file.size < 100) {
    return {
      isValid: false,
      error: 'File is too small to be a valid audio file'
    };
  }

  // Check file type
  const isTypeSupported = SUPPORTED_FORMATS.some(format => 
    file.type.includes(format.split('/')[1]) || 
    file.name.toLowerCase().includes(format.split('/')[1])
  );

  if (!isTypeSupported) {
    return {
      isValid: false,
      error: `Unsupported file format. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`
    };
  }

  return { isValid: true };
}

function sanitizeFileName(fileName) {
  // Ensure we have a reasonable filename for OpenAI
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const parts = cleaned.split('.');
  const extension = parts.pop() || 'webm';
  const baseName = parts.join('.') || 'audio';
  
  return `${baseName.slice(0, 50)}.${extension}`;
}

/* ------------------ HANDLER ------------------ */
export async function POST(req) {
  try {
    // Environment check
    if (!OPENAI_API_KEY) {
      console.error('Transcription API called without OpenAI API key configured');
      return NextResponse.json(
        { error: "Transcription service is not properly configured" },
        { status: 500 }
      );
    }

    // Parse multipart form data
    let formData;
    try {
      formData = await req.formData();
    } catch (error) {
      return NextResponse.json(
        { error: "Invalid form data" },
        { status: 400 }
      );
    }

    const file = formData.get('file');
    if (!file) {
      return NextResponse.json(
        { error: "No audio file provided" },
        { status: 400 }
      );
    }

    console.log(`Transcription request: ${file.name} (${file.size} bytes, ${file.type})`);

    // Validate the audio file
    const validation = validateAudioFile(file);
    if (!validation.isValid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    // Prepare file for OpenAI - use the original file with sanitized name property
    const sanitizedName = sanitizeFileName(file.name || 'audio.webm');
    
    // Add the sanitized name as a property for OpenAI
    Object.defineProperty(file, 'name', { 
      value: sanitizedName, 
      writable: false 
    });

    console.log(`Starting transcription with Whisper API: ${sanitizedName}`);
    
    const startTime = Date.now();

    // Call OpenAI Whisper API - pass the file directly
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: "whisper-1",
      response_format: "verbose_json", // Get timestamps
      timestamp_granularities: ["segment"], // Get segment-level timestamps
    });

    const processingTime = Date.now() - startTime;

    // Validate transcription response
    if (!transcription.text || transcription.text.trim().length === 0) {
      return NextResponse.json(
        { error: "No speech detected in audio file" },
        { status: 422 }
      );
    }

    // Process segments for consistent format
    const segments = (transcription.segments || []).map((seg) => ({
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: (seg.text || '').trim()
    })).filter((seg) => seg.text.length > 0);

    const response = {
      text: transcription.text.trim(),
      segments: segments,
      language: transcription.language || 'unknown',
      duration: transcription.duration || 0
    };

    console.log(`Transcription completed: ${response.text.length} characters, ${segments.length} segments in ${processingTime}ms`);

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'X-Processing-Time': processingTime.toString(),
        'X-Segments-Count': segments.length.toString(),
        'X-Text-Length': response.text.length.toString(),
      }
    });

  } catch (error) {
    // Enhanced error logging
    console.error('Transcription failed:', {
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      timestamp: new Date().toISOString(),
    });

    // Determine error type and provide user-friendly messages
    let userMessage = "Transcription failed";
    let statusCode = 500;

    if (error.message?.includes('API key')) {
      userMessage = "Transcription service configuration error";
      statusCode = 503;
    } else if (error.message?.includes('rate limit') || error.message?.includes('quota')) {
      userMessage = "Transcription service is temporarily busy, please try again";
      statusCode = 429;
    } else if (error.message?.includes('timeout')) {
      userMessage = "Transcription timed out, please try again with a shorter audio file";
      statusCode = 504;
    } else if (error.message?.includes('file') || error.message?.includes('format')) {
      userMessage = "Audio file format not supported or corrupted";
      statusCode = 422;
    } else if (error.message?.includes('duration') || error.message?.includes('too long')) {
      userMessage = "Audio file is too long. Please use audio shorter than 10 minutes";
      statusCode = 422;
    } else if (error.message?.includes('network') || error.message?.includes('fetch')) {
      userMessage = "Network error during transcription, please try again";
      statusCode = 503;
    }

    return NextResponse.json({
      error: userMessage,
      ...(process.env.NODE_ENV === 'development' && {
        debug: error.message,
        type: error.constructor.name
      })
    }, { status: statusCode });
  }
}