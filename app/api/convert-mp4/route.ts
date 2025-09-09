// app/api/convert-mp4/route.ts
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { access, writeFile, readFile, unlink } from "fs/promises";
import { constants as FsConstants } from "fs";
import os from "os";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FPS = 30;

/** Choose a safe temp path. */
function tmpPath(ext: string) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `audiograffiti-${id}.${ext}`);
}

/** Resolve ffmpeg via env first, then ffmpeg-static. */
async function resolveFfmpegPath(): Promise<{ path: string; source: "env" | "static" }> {
  const envPath = process.env.FFMPEG_PATH?.trim();
  if (envPath) {
    try {
      await access(envPath, FsConstants.X_OK).catch(async () => {
        await access(envPath, FsConstants.F_OK);
      });
      return { path: envPath, source: "env" };
    } catch {
      // fall through
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require("ffmpeg-static") as string | undefined;
    if (ffmpegStatic) return { path: ffmpegStatic, source: "static" };
  } catch {}
  throw new Error("ffmpeg not found. Set FFMPEG_PATH or install ffmpeg-static.");
}

export async function POST(req: NextRequest) {
  let usedBinary = "";
  let triedPath = "";
  let stderrBuf: Buffer[] = [];

  // temp files we’ll clean up
  let inPath: string | null = null;
  let outPath: string | null = null;

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength < 1024) {
      return NextResponse.json({ error: "Input video too small." }, { status: 400 });
    }

    // Pick input extension based on MIME (helps some ffmpeg builds)
    const mime = (file as any).type || "";
    const ext =
      mime.includes("webm") ? "webm" :
      mime.includes("ogg") ? "ogg" :
      mime.includes("wav") ? "wav" :
      mime.includes("mpeg") || mime.includes("mp3") ? "mp3" :
      "dat";

    inPath = tmpPath(ext);
    outPath = tmpPath("mp4");

    // Write input to disk
    await writeFile(inPath, buf);

    // Resolve ffmpeg
    const { path: ffmpegPath } = await resolveFfmpegPath();
    usedBinary = ffmpegPath;
    triedPath = ffmpegPath;

    // File → file transcode (no pipes)
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", inPath,

      // Video (ok if audio-only; ffmpeg will create a tiny black video stream)
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(FPS),

      // Audio
      "-c:a", "aac",
      "-b:a", "192k",

      // Make MP4 seek fast on the web
      "-movflags", "+faststart",

      // Output file
      outPath,
    ];

    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: false,
    });

    child.stderr.on("data", (d) => {
      stderrBuf.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    });

    const code: number = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(typeof exitCode === "number" ? exitCode : 1));
    });

    const stderrTail = Buffer.concat(stderrBuf).toString("utf8").slice(-2000);

    if (code !== 0) {
      return NextResponse.json(
        { error: "Transcode failed.", ffmpegPathTried: triedPath, usedBinary, stderrTail },
        { status: 500 }
      );
    }

    // Read result and send
    const mp4 = await readFile(outPath);
    if (mp4.length < 1024) {
      return NextResponse.json(
        { error: "MP4 output unexpectedly small.", ffmpegPathTried: triedPath, usedBinary, stderrTail },
        { status: 500 }
      );
    }

    return new NextResponse(mp4, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="audiograffiti.mp4"',
      },
    });
  } catch (err: any) {
    const stderrTail = Buffer.concat(stderrBuf).toString("utf8").slice(-2000);
    return NextResponse.json(
      {
        error: err?.message || "Convert error.",
        ffmpegPathTried: triedPath || process.env.FFMPEG_PATH || "(none)",
        usedBinary: usedBinary || "(none)",
        stderrTail,
      },
      { status: 500 }
    );
  } finally {
    // Clean up temp files
    if (inPath) { try { await unlink(inPath); } catch {} }
    if (outPath) { try { await unlink(outPath); } catch {} }
  }
}

/** Optional GET ping for health/debug. */
export async function GET() {
  try {
    let ffmpegPath = "(not checked)";
    try {
      const { path } = await resolveFfmpegPath();
      ffmpegPath = path;
    } catch {
      ffmpegPath = "(not found)";
    }
    return NextResponse.json({ ok: true, message: "convert-mp4 route is alive", ffmpegPath, runtime: "nodejs" });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown" }, { status: 500 });
  }
}
