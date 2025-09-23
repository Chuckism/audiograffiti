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

    const file = formData.get('audio') || formData.get('file');
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
      console.log(`Attempting transcription with file: ${sanitizedName}, size: ${buffer.length}, type: ${file.type}`);
      
      // Create form data for OpenAI API (more reliable than Blob for file uploads)
      const openaiFormData = new FormData();
      
      // Create a proper file-like object for OpenAI
      const fileForOpenAI = new Blob([buffer], { type: file.type || 'audio/mpeg' });
      
      openaiFormData.append('file', fileForOpenAI, sanitizedName);
      openaiFormData.append('model', 'whisper-1');
      openaiFormData.append('response_format', 'verbose_json');
      openaiFormData.append('timestamp_granularities[]', 'segment');

      // Make direct fetch request to OpenAI API instead of using client
      const openaiResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: openaiFormData
      });

      if (!openaiResponse.ok) {
        const errorText = await openaiResponse.text();
        console.error(`OpenAI API error: ${openaiResponse.status} - ${errorText}`);
        throw new Error(`OpenAI API error: ${openaiResponse.status}`);
      }

      transcription = await openaiResponse.json();
      
      console.log(`Transcription successful: ${transcription.segments?.length || 0} segments`);
    } catch (apiError) {
      console.error('OpenAI API error:', {
        message: apiError.message,
        status: apiError.status,
        code: apiError.code
      });

      if (apiError.message?.includes('413') || apiError.status === 413) {
        return NextResponse.json(
          { error: 'Audio file too large for transcription' },
          { status: 413 }
        );
      }

      if (apiError.message?.includes('400') || apiError.status === 400) {
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