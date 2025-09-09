import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const audioFile = formData.get('audio') as File
    const style = formData.get('style') as string

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
    }

    // Step 1: Transcribe the audio using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'json',
    })

    const transcript = transcription.text

    // Step 2: Generate video with waveform and captions
    const videoData = await generateVideoWithStyle(audioFile, transcript, style)

    return NextResponse.json({
      success: true,
      transcript,
      style,
      videoUrl: videoData.url,
    })

  } catch (error) {
    console.error('Error processing audio:', error)
    return NextResponse.json(
      { error: 'Failed to process audio' },
      { status: 500 }
    )
  }
}

async function generateVideoWithStyle(audioFile: File, transcript: string, style: string) {
  // Create form data for the video generation API
  const formData = new FormData()
  formData.append('audio', audioFile)
  formData.append('transcript', transcript)
  formData.append('style', style)
  
  try {
    // Call our real video generation API
    const response = await fetch(`${process.env.NEXTJS_URL || 'http://localhost:3000'}/api/create-video`, {
      method: 'POST',
      body: formData
    })
    
    if (response.ok) {
      // For now, return a data URL of the generated frame
      const videoBuffer = await response.arrayBuffer()
      const base64 = Buffer.from(videoBuffer).toString('base64')
      const dataUrl = `data:image/png;base64,${base64}`
      
      return {
        url: dataUrl,
        duration: 5,
        transcript
      }
    } else {
      throw new Error('Video generation failed')
    }
  } catch (error) {
    console.error('Video generation error:', error)
    // Fallback to mock video
    const mockVideoUrl = `/api/mock-video?style=${style}&text=${encodeURIComponent(transcript.substring(0, 50))}`
    return {
      url: mockVideoUrl,
      duration: 30,
      transcript
    }
  }
}

// Mock video endpoint for development  
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const style = url.searchParams.get('style') || 'classic'
  const text = url.searchParams.get('text') || 'Sample text'
  
  // Return a data URL for a simple canvas-based video preview
  const canvas = createMockVideoCanvas(style, text)
  
  return new Response(canvas, {
    headers: { 'Content-Type': 'text/html' },
  })
}

function createMockVideoCanvas(style: string, text: string) {
  return `
    <html>
      <body style="margin:0; background: ${getStyleBackground(style)}; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: Arial;">
        <div style="text-align: center; color: white; padding: 20px;">
          <h2 style="margin-bottom: 20px;">AudioGraffiti</h2>
          <div style="background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px; margin-bottom: 20px;">
            <div style="width: 200px; height: 4px; background: #4ade80; border-radius: 2px; animation: wave 2s infinite;"></div>
          </div>
          <p style="max-width: 300px; line-height: 1.5;">${decodeURIComponent(text)}</p>
          <small style="opacity: 0.7;">Created with AudioGraffiti</small>
        </div>
        <style>
          @keyframes wave {
            0%, 100% { transform: scaleX(1); }
            50% { transform: scaleX(1.5); }
          }
        </style>
      </body>
    </html>
  `
}

function getStyleBackground(style: string): string {
  switch (style.toLowerCase()) {
    case 'neon':
      return 'linear-gradient(45deg, #ff006e, #8338ec, #3a86ff)'
    case 'minimalist':
      return 'linear-gradient(45deg, #f8f9fa, #e9ecef)'
    case 'classic':
    default:
      return 'linear-gradient(45deg, #667eea, #764ba2)'
  }
}