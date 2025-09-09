// app/api/tts/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------ CONFIG ------------------ */
const MODEL = process.env.TTS_MODEL?.trim() || "tts-1"; // lock to tts-1
const DEFAULT_FORMAT = "mp3"; // mp3|wav|ogg
const CACHE_DIR =
  process.env.TTS_CACHE_DIR?.trim() ||
  path.join(process.cwd(), ".next", "tts-cache"); // local-friendly default
const TTL_HOURS = Number(process.env.TTS_CACHE_TTL_HOURS || 720); // 30 days
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

/* ------------------ CLIENT ------------------ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------ UTILS ------------------ */
function mimeFrom(format: string) {
  switch ((format || "").toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    default:    return "application/octet-stream";
  }
}
function normalizeSpaces(s: string) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
function shardPath(root: string, hash: string, ext: string) {
  const a = hash.slice(0, 2) || "00";
  const b = hash.slice(2, 4) || "00";
  return path.join(root, a, b, `${hash}.${ext}`);
}
async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function readFreshFileIfAny(p: string) {
  try {
    const st = await fs.stat(p);
    const age = Date.now() - st.mtimeMs;
    if (age <= TTL_MS && st.size > 0) return await fs.readFile(p);
  } catch {}
  return null;
}

/* ------------------ HANDLER ------------------ */
export async function POST(req: NextRequest) {
  try {
    const { text, voice = "alloy", format = DEFAULT_FORMAT, userId, bypassCache } =
      (await req.json().catch(() => ({}))) as {
        text?: string;
        voice?: string;
        format?: "mp3" | "wav" | "ogg";
        userId?: string;
        bypassCache?: boolean;
      };

    const bypass =
      !!bypassCache ||
      req.nextUrl.searchParams.get("bypass") === "1" ||
      req.headers.get("x-bypass-cache") === "1";

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Missing text." }, { status: 400 });
    }
    const normText = normalizeSpaces(text);
    if (!normText) {
      return NextResponse.json({ error: "Empty text." }, { status: 400 });
    }

    const softUser =
      (typeof userId === "string" && userId) ||
      req.headers.get("x-user-id") ||
      "anon";

    const ext = (format || DEFAULT_FORMAT).toLowerCase();
    const key = sha256(
      [softUser, MODEL, voice || "", ext, normText].join(":")
    );
    const filePath = shardPath(CACHE_DIR, key, ext);

    if (!bypass) {
      await ensureDir(path.dirname(filePath));
      const hit = await readFreshFileIfAny(filePath);
      if (hit) {
        return new NextResponse(hit, {
          status: 200,
          headers: {
            "Content-Type": mimeFrom(ext),
            "Cache-Control": "no-store",
            "X-Cache-Hit": "1",
          },
        });
      }
    }

    // Generate fresh (locked to tts-1)
    const r = await openai.audio.speech.create({
      model: MODEL, // "tts-1"
      voice,
      input: normText,
      format: ext as any, // "mp3" | "wav" | "ogg"
    });
    const audio = Buffer.from(await r.arrayBuffer());

    try {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, audio);
    } catch { /* ignore cache write errors */ }

    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": mimeFrom(ext),
        "Cache-Control": "no-store",
        "X-Cache-Hit": "0",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "TTS error." },
      { status: 500 }
    );
  }
}

