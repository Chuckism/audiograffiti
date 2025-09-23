// app/api/convert-mp4/route.js
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for video processing

/* ------------------ CONFIG ------------------ */
const TEMP_DIR = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(process.cwd(), '.next', 'temp');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB max file size
const CLEANUP_DELAY = 5000; // 5 seconds before cleanup

/* ------------------ UTILS ------------------ */
function generateTempId() {
  return createHash('md5').update(Date.now() + Math.random().toString()).digest('hex').slice(0, 12);
}

async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.warn('Temp directory creation failed:', error);
  }
}

async function cleanupFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    console.warn('File cleanup failed:', filePath, error);
  }
}

function findFFmpegPath() {
  // Common FFmpeg locations in different environments
  const possiblePaths = [
    '/usr/bin/ffmpeg',           // Standard Linux
    '/usr/local/bin/ffmpeg',     // Homebrew/custom installs
    'ffmpeg',                    // System PATH
  ];

  // In production (Render), FFmpeg should be available in PATH
  if (process.env.NODE_ENV === 'production') {
    return 'ffmpeg';
  }

  // For development, try to find FFmpeg
  return possiblePaths[0]; // Default to standard location
}

async function convertWebMToMP4(inputPath, outputPath) {
  const ffmpegPath = findFFmpegPath();
  
  return new Promise((resolve) => {
    const args = [
      '-i', inputPath,                    // Input file
      '-c:v', 'libx264',                  // Video codec
      '-c:a', 'aac',                      // Audio codec
      '-preset', 'medium',                // Encoding speed vs quality balance
      '-crf', '23',                       // Quality setting (18-28 range)
      '-movflags', '+faststart',          // Web optimization
      '-y',                               // Overwrite output file
      outputPath                          // Output file
    ];

    console.log(`Starting FFmpeg conversion: ${ffmpegPath} ${args.join(' ')}`);
    
    const ffmpeg = spawn(ffmpegPath, args);
    let stdout = '';
    let stderr = '';

    ffmpeg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      const success = code === 0;
      
      if (success) {
        console.log('FFmpeg conversion completed successfully');
      } else {
        console.error('FFmpeg conversion failed with code:', code);
        console.error('FFmpeg stderr:', stderr.slice(-500)); // Last 500 chars
      }

      resolve({
        success,
        ffmpegPath,
        stderr: stderr.slice(-1000), // Last 1000 chars for debugging
        stdout: stdout.slice(-500)   // Last 500 chars
      });
    });

    ffmpeg.on('error', (error) => {
      console.error('FFmpeg spawn error:', error);
      resolve({
        success: false,
        ffmpegPath,
        stderr: `Spawn error: ${error.message}`,
      });
    });
  });
}

/* ------------------ HANDLER ------------------ */
export async function POST(req) {
  const tempId = generateTempId();
  let inputPath = null;
  let outputPath = null;

  try {
    // Ensure temp directory exists
    await ensureTempDir();

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 413 }
      );
    }

    // Validate file type
    if (!file.type.includes('webm') && !file.name.toLowerCase().includes('webm')) {
      return NextResponse.json(
        { error: 'Only WebM files are supported' },
        { status: 400 }
      );
    }

    console.log(`Processing video conversion: ${file.name} (${file.size} bytes)`);

    // Setup file paths
    inputPath = path.join(TEMP_DIR, `input_${tempId}.webm`);
    outputPath = path.join(TEMP_DIR, `output_${tempId}.mp4`);

    // Write input file
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(inputPath, buffer);

    console.log(`Input file written: ${inputPath}`);

    // Convert with FFmpeg
    const conversionResult = await convertWebMToMP4(inputPath, outputPath);

    if (!conversionResult.success) {
      return NextResponse.json({
        error: 'Video conversion failed',
        ffmpegPath: conversionResult.ffmpegPath,
        stderrTail: conversionResult.stderr,
      }, { status: 500 });
    }

    // Verify output file exists and has content
    try {
      const outputStats = await fs.stat(outputPath);
      if (outputStats.size === 0) {
        throw new Error('Output file is empty');
      }
      console.log(`Conversion successful: ${outputStats.size} bytes`);
    } catch (error) {
      return NextResponse.json({
        error: 'Conversion appeared to succeed but output file is invalid',
        ffmpegPath: conversionResult.ffmpegPath,
        stderrTail: conversionResult.stderr,
      }, { status: 500 });
    }

    // Read output file
    const outputBuffer = await fs.readFile(outputPath);

    // Schedule cleanup (don't await - let it happen in background)
    setTimeout(async () => {
      if (inputPath) await cleanupFile(inputPath);
      if (outputPath) await cleanupFile(outputPath);
    }, CLEANUP_DELAY);

    // Return MP4 file
    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="audiograffiti-export.mp4"',
        'X-Conversion-Success': '1',
        'X-FFmpeg-Path': conversionResult.ffmpegPath || 'unknown',
      },
    });

  } catch (error) {
    console.error('Video conversion error:', {
      error: error.message,
      stack: error.stack,
      tempId,
      timestamp: new Date().toISOString(),
    });

    // Emergency cleanup
    if (inputPath) await cleanupFile(inputPath);
    if (outputPath) await cleanupFile(outputPath);

    // Determine error type and provide appropriate response
    let statusCode = 500;
    let errorMessage = 'Video conversion failed';

    if (error.message?.includes('ENOENT') || error.message?.includes('spawn')) {
      errorMessage = 'Video conversion service unavailable';
      statusCode = 503;
    } else if (error.message?.includes('timeout')) {
      errorMessage = 'Video conversion timed out';
      statusCode = 504;
    } else if (error.message?.includes('disk') || error.message?.includes('space')) {
      errorMessage = 'Insufficient server resources for conversion';
      statusCode = 507;
    }

    return NextResponse.json({
      error: errorMessage,
      tempId,
      ...(process.env.NODE_ENV === 'development' && {
        debug: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n')
      })
    }, { status: statusCode });
  }
}