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
  // In production (Render), FFmpeg should be available in the system PATH
  if (process.env.NODE_ENV === 'production') {
    return 'ffmpeg';
  }
  // For local development, you might need to specify a path
  return 'ffmpeg';
}

async function convertWebMToMP4(inputPath, outputPath) {
  const ffmpegPath = findFFmpegPath();
  
  return new Promise((resolve) => {
    // --- CRITICAL FIX APPLIED HERE ---
    // Switched from 'medium' preset to 'ultrafast' to ensure completion within serverless limits.
    // Adjusted CRF to 28 to maintain reasonable quality and file size with the faster preset.
    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'ultrafast', // Use the fastest preset
      '-crf', '28',           // Adjust quality for the faster preset
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];

    console.log(`Starting FFmpeg conversion: ${ffmpegPath} ${args.join(' ')}`);
    
    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      const success = code === 0;
      
      if (success) {
        console.log('FFmpeg conversion completed successfully');
      } else {
        console.error('FFmpeg conversion failed with code:', code);
        console.error('FFmpeg stderr:', stderr.slice(-1000)); // Log last 1000 chars of error
      }

      resolve({
        success,
        ffmpegPath,
        stderr: stderr.slice(-1000),
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
    await ensureTempDir();
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `File too large. Max is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, { status: 413 });
    }

    if (!file.type.includes('webm') && !file.name.toLowerCase().includes('webm')) {
        return NextResponse.json({ error: 'Only WebM files are supported' }, { status: 400 });
    }

    console.log(`Processing video conversion: ${file.name} (${file.size} bytes)`);

    inputPath = path.join(TEMP_DIR, `input_${tempId}.webm`);
    outputPath = path.join(TEMP_DIR, `output_${tempId}.mp4`);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(inputPath, buffer);

    console.log(`Input file written: ${inputPath}`);

    const conversionResult = await convertWebMToMP4(inputPath, outputPath);

    if (!conversionResult.success) {
      return NextResponse.json({
        error: 'Video conversion failed on the server',
        ffmpegPath: conversionResult.ffmpegPath,
        stderrTail: conversionResult.stderr,
      }, { status: 500 });
    }

    try {
      const outputStats = await fs.stat(outputPath);
      if (outputStats.size === 0) throw new Error('Output file is empty');
      console.log(`Conversion successful: ${outputStats.size} bytes`);
    } catch (error) {
      return NextResponse.json({
        error: 'Conversion succeeded but output file is invalid',
        stderrTail: conversionResult.stderr,
      }, { status: 500 });
    }

    const outputBuffer = await fs.readFile(outputPath);

    setTimeout(async () => {
      if (inputPath) await cleanupFile(inputPath);
      if (outputPath) await cleanupFile(outputPath);
    }, CLEANUP_DELAY);

    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="audiograffiti-export.mp4"',
      },
    });

  } catch (error) {
    console.error('Video conversion handler error:', {
      message: error.message,
      stack: error.stack,
      tempId,
    });

    if (inputPath) await cleanupFile(inputPath);
    if (outputPath) await cleanupFile(outputPath);

    return NextResponse.json({
      error: 'An unexpected error occurred during video conversion.',
    }, { status: 500 });
  }
}