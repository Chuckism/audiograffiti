// app/api/transcribe/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------- Brand glossary (server-controlled) ----------------- */
/** Map common mishears -> canonical brand spelling. Users cannot modify this. */
const BRAND_GLOSSARY: Array<[RegExp, string]> = [
  // “graffi” variants
  [/\byurography\b/gi, "graffi"],
  [/\burography\b/gi, "graffi"],
  [/\byour ?graphy\b/gi, "graffi"],
  [/\byour ?graffy\b/gi, "graffi"],
  [/\bgraffy\b/gi, "graffi"],
  // Brand casing
  [/\baudio ?graffiti\b/gi, "AudioGraffiti"],
];

function normalizeBrand(s: string) {
  let t = s;
  for (const [rx, repl] of BRAND_GLOSSARY) t = t.replace(rx, repl);
  return t;
}

/* ----------------------------- Handler ----------------------------- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const arrayBuf = await file.arrayBuffer();
    if (arrayBuf.byteLength < 64) {
      return NextResponse.json({ error: "Audio too small or empty." }, { status: 400 });
    }

    // Whisper (verbose_json gives timestamped segments)
    const tf = await toFile(Buffer.from(arrayBuf), "audio.webm", {
      type: (file as any).type || "audio/webm",
    });

    const tr = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: tf,
      response_format: "verbose_json",
      // language: "en", // optionally bias to English if your content is always English
    });

    // Server-side normalization (brand-safe)
    const text = normalizeBrand((tr?.text || "").trim());

    const segments =
      (Array.isArray((tr as any)?.segments) ? (tr as any).segments : []).map((s: any) => ({
        start: s.start,
        end: s.end,
        text: normalizeBrand((s.text || "").trim()),
      }));

    return NextResponse.json(
      { text, segments },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Transcription error." },
      { status: 500 }
    );
  }
}

