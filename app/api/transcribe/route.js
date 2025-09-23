// app/api/transcribe/route.js
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 minute timeout for transcription

/* ------------------ CONFIG ------------------ */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB limit
const MIN_FILE_SIZE = 1024; // 1KB minimum
const ALLOWED_TYPES = ['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/ogg'];

/* ------------------ HELPER FUNCTIONS ------------------ */
function validateAudioFile(file) {
  if (!file) {
    return { isValid: false, error: 'No audio file provided' };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { isValid: false, error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` };
  }

  if (file.size < MIN_FILE_SIZE) {
    return { isValid: false, error: 'File too small. Minimum size is 1KB' };
  }

  if (file.type && !ALLOWED_TYPES.includes(file.type)) {
    return { isValid: false, error: `Unsupported file type: ${file.type}. Supported types: ${ALLOWED_TYPES.join(', ')}` };
  }

  return { isValid: true };
}

function sanitizeFileName(fileName) {
  if (!fileName) return 'audio.webm';
  return fileName.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 100);
}

/* ------------------ MAIN API HANDLER ------------------ */
export async function POST(req) {
  try {
    console.log('Transcription API called');

    // Validate environment
    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OpenAI API key');
      return NextResponse.json(
        { error: 'OpenAI API key not configured' },
        { status: 500 }
      );
    }

    // Parse form data
    let formData;
    try {
      formData = await req.formData();
    } catch (error) {
      console.error('Failed to parse form data:', error);
      return NextResponse.json(
        { error: 'Invalid form data' },
        { status: 400 }
      );
    }

    const file = formData.get('audio');
    if (!file) {
      console.error('No audio file in form data');
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    // Validate file
    const validation = validateAudioFile(file);
    if (!validation.isValid) {
      console.error('File validation failed:', validation.error);
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    const sanitizedName = sanitizeFileName(file.name || 'audio.webm');
    console.log(`Transcription request: ${sanitizedName} (${file.size} bytes, ${file.type || 'unknown type'})`);

    // Convert file to buffer for OpenAI API
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Transcribe using OpenAI Whisper API
    let transcription;
    try {
      // Create a Blob with the correct name property for OpenAI API
      const audioBlob = new Blob([buffer], { type: file.type || 'audio/webm' });
      // Add name property that OpenAI expects
      audioBlob.name = sanitizedName;

      transcription = await openai.audio.transcriptions.create({
        file: audioBlob,
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment']
      });
      
      console.log(`Transcription successful: ${transcription.segments?.length || 0} segments`);
    } catch (apiError) {
      console.error('OpenAI API error:', {
        message: apiError.message,
        status: apiError.status,
        code: apiError.code
      });

      if (apiError.status === 413) {
        return NextResponse.json(
          { error: 'Audio file too large for transcription' },
          { status: 413 }
        );
      }

      if (apiError.status === 400) {
        return NextResponse.json(
          { error: 'Invalid audio format or corrupted file' },
          { status: 400 }
        );
      }

      return NextResponse.json(
        { error: 'Transcription service temporarily unavailable' },
        { status: 503 }
      );
    }

    // Process segments
    const segments = (transcription.segments || []).map((segment, index) => ({
      id: index,
      start: segment.start || 0,
      end: segment.end || 1,
      text: (segment.text || '').trim()
    })).filter(seg => seg.text.length > 0);

    console.log(`Processed ${segments.length} valid segments`);

    // Return successful response
    return NextResponse.json({
      success: true,
      text: transcription.text || '',
      segments: segments,
      duration: segments.length > 0 ? Math.max(...segments.map(s => s.end)) : 0,
      metadata: {
        fileSize: file.size,
        fileName: sanitizedName,
        segmentCount: segments.length
      }
    });

  } catch (error) {
    console.error('Transcription failed:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    return NextResponse.json(
      { 
        error: 'Internal transcription error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      },
      { status: 500 }
    );
  }
}