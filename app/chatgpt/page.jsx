'use client'

import { useState, useRef, useEffect } from 'react'

export default function AudioGraffiti() {
  const [appState, setAppState] = useState('recording')
  const [isRecording, setIsRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState(null)
  const [selectedStyle, setSelectedStyle] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [transcript, setTranscript] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const canvasRef = useRef(null)
  const audioRef = useRef(null)

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' })
        setAudioBlob(audioBlob)
        setAudioUrl(URL.createObjectURL(audioBlob))
        setAppState('selecting-style')
      }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (err) {
      console.error('Error accessing microphone:', err)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop())
      setIsRecording(false)
    }
  }

  const selectStyle = (style) => {
    setSelectedStyle(style)
    generateVideo(style)
  }

  const generateVideo = async (style) => {
    if (!audioBlob) return
    
    setAppState('generating')
    
    const formData = new FormData()
    formData.append('audio', audioBlob)
    formData.append('style', style)
    
    try {
      const response = await fetch('/api/generate-video', {
        method: 'POST',
        body: formData
      })
      
      if (response.ok) {
        const data = await response.json()
        setTranscript(data.transcript)
        // Instead of setting videoUrl, we'll create the visual directly
        setAppState('sharing')
        setTimeout(() => {
          createAudioVisualization(style, data.transcript)
        }, 100)
      } else {
        console.error('Failed to generate video')
        setAppState('recording')
      }
    } catch (error) {
      console.error('Error generating video:', error)
      setAppState('recording')
    }
  }

  const createAudioVisualization = async (style, transcript) => {
    if (!canvasRef.current || !audioRef.current) return
    
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const audio = audioRef.current
    
    if (!ctx) return
    
    // Set canvas size
    canvas.width = 1080
    canvas.height = 1920
    
    // Create audio context for waveform analysis
    const audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const analyser = audioContext.createAnalyser()
    const source = audioContext.createMediaElementSource(audio)
    
    source.connect(analyser)
    analyser.connect(audioContext.destination)
    
    analyser.fftSize = 256
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    
    const styleConfig = getStyleConfig(style)
    
    const animate = () => {
      analyser.getByteFrequencyData(dataArray)
      
      // Clear canvas with gradient background
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
      gradient.addColorStop(0, styleConfig.background1)
      gradient.addColorStop(1, styleConfig.background2)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      
      // Draw waveform
      const barWidth = canvas.width / bufferLength
      let x = 0
      
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height * 0.5
        
        ctx.fillStyle = styleConfig.waveformColor
        ctx.fillRect(x, canvas.height / 2 - barHeight / 2, barWidth - 2, barHeight)
        
        x += barWidth
      }
      
      // Draw transcript
      ctx.fillStyle = styleConfig.textColor
      ctx.font = 'bold 48px Arial'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      
      const words = transcript.split(' ')
      const maxWidth = canvas.width - 100
      const lines = wrapText(ctx, transcript, maxWidth)
      const lineHeight = 60
      const totalHeight = lines.length * lineHeight
      const startY = canvas.height * 0.75 - totalHeight / 2
      
      lines.forEach((line, index) => {
        ctx.fillText(line, canvas.width / 2, startY + index * lineHeight)
      })
      
      // Draw branding
      ctx.fillStyle = styleConfig.textColor
      ctx.font = '24px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('Created with AudioGraffiti', canvas.width / 2, canvas.height - 50)
      
      if (!audio.paused) {
        requestAnimationFrame(animate)
      }
    }
    
    audio.addEventListener('play', animate)
    audio.play()
  }

  const getStyleConfig = (style) => {
    switch (style.toLowerCase()) {
      case 'neon':
        return {
          background1: '#ff006e',
          background2: '#8338ec',
          waveformColor: '#00f5ff',
          textColor: '#ffffff'
        }
      case 'minimalist':
        return {
          background1: '#f8f9fa',
          background2: '#e9ecef',
          waveformColor: '#495057',
          textColor: '#212529'
        }
      default: // classic
        return {
          background1: '#667eea',
          background2: '#764ba2',
          waveformColor: '#ffffff',
          textColor: '#ffffff'
        }
    }
  }

  const wrapText = (ctx, text, maxWidth) => {
    const words = text.split(' ')
    const lines = []
    let currentLine = ''
    
    for (const word of words) {
      const testLine = currentLine + (currentLine ? ' ' : '') + word
      const metrics = ctx.measureText(testLine)
      
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine)
        currentLine = word
      } else {
        currentLine = testLine
      }
    }
    
    if (currentLine) {
      lines.push(currentLine)
    }
    
    return lines
  }

  const resetApp = () => {
    setAppState('recording')
    setIsRecording(false)
    setAudioBlob(null)
    setSelectedStyle('')
    setVideoUrl('')
    setTranscript('')
    setAudioUrl('')
  }

  const downloadCanvas = () => {
    if (!canvasRef.current) return
    
    const link = document.createElement('a')
    link.download = 'audiograffiti.png'
    link.href = canvasRef.current.toDataURL()
    link.click()
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white/10 backdrop-blur-lg rounded-3xl p-8 shadow-2xl">
        
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">AudioGraffiti</h1>
          <p className="text-blue-200 text-sm">Your voice, instantly visual</p>
        </div>

        {/* Recording State */}
        {appState === 'recording' && (
          <div className="text-center">
            <div className="mb-8">
              <div className={`w-32 h-32 mx-auto rounded-full border-4 flex items-center justify-center transition-all duration-300 ${
                isRecording 
                  ? 'border-red-400 bg-red-500/20 animate-pulse' 
                  : 'border-blue-400 bg-blue-500/20'
              }`}>
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`w-16 h-16 rounded-full transition-all duration-300 ${
                    isRecording 
                      ? 'bg-red-500 hover:bg-red-600' 
                      : 'bg-blue-500 hover:bg-blue-600'
                  }`}
                >
                  {isRecording ? (
                    <div className="w-6 h-6 bg-white rounded-sm mx-auto"></div>
                  ) : (
                    <div className="w-0 h-0 border-l-[12px] border-l-white border-t-[8px] border-t-transparent border-b-[8px] border-b-transparent ml-1"></div>
                  )}
                </button>
              </div>
            </div>
            <p className="text-white text-lg mb-2">
              {isRecording ? 'Recording...' : 'Tap to record your thought'}
            </p>
            <p className="text-blue-200 text-sm">
              {isRecording ? 'Tap the red button when finished' : 'Say anything that comes to mind'}
            </p>
          </div>
        )}

        {/* Style Selection State */}
        {appState === 'selecting-style' && (
          <div>
            <h2 className="text-xl text-white font-semibold mb-6 text-center">Choose your style</h2>
            <div className="space-y-4">
              {['Classic', 'Neon', 'Minimalist'].map((style) => (
                <button
                  key={style}
                  onClick={() => selectStyle(style)}
                  className="w-full p-4 rounded-xl bg-white/10 hover:bg-white/20 transition-all duration-300 text-white font-medium border border-white/20 hover:border-white/40"
                >
                  {style}
                </button>
              ))}
            </div>
            <button
              onClick={resetApp}
              className="w-full mt-6 p-3 rounded-xl bg-gray-600/50 hover:bg-gray-600/70 transition-all duration-300 text-white"
            >
              Record Again
            </button>
          </div>
        )}

        {/* Generating State */}
        {appState === 'generating' && (
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-6 border-4 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
            <h2 className="text-xl text-white font-semibold mb-2">Creating your video...</h2>
            <p className="text-blue-200">This will take just a moment</p>
          </div>
        )}

        {/* Sharing State */}
        {appState === 'sharing' && (
          <div className="text-center">
            <h2 className="text-xl text-white font-semibold mb-6">Your video is ready!</h2>
            
            {/* Debug: Show transcript */}
            {transcript && (
              <div className="mb-4 p-3 bg-white/10 rounded-lg">
                <p className="text-sm text-blue-200">Transcript:</p>
                <p className="text-white text-sm">{transcript}</p>
              </div>
            )}
            
            {/* Live Canvas Visualization */}
            <div className="mb-6 bg-black rounded-xl overflow-hidden">
              <canvas 
                ref={canvasRef}
                className="w-full h-64 object-cover"
                style={{ aspectRatio: '9/16' }}
              />
              <audio 
                ref={audioRef}
                src={audioUrl}
                controls 
                className="w-full"
              />
            </div>
            
            <div className="space-y-3">
              <button 
                onClick={downloadCanvas}
                className="w-full p-3 rounded-xl bg-green-600 hover:bg-green-700 transition-all duration-300 text-white font-medium"
              >
                Download Image
              </button>
              <button className="w-full p-3 rounded-xl bg-blue-600 hover:bg-blue-700 transition-all duration-300 text-white font-medium">
                Share to Instagram
              </button>
              <button className="w-full p-3 rounded-xl bg-pink-600 hover:bg-pink-700 transition-all duration-300 text-white font-medium">
                Share to TikTok
              </button>
            </div>
            <button
              onClick={resetApp}
              className="w-full mt-6 p-3 rounded-xl bg-gray-600/50 hover:bg-gray-600/70 transition-all duration-300 text-white"
            >
              Create Another
            </button>
          </div>
        )}
      </div>
    </div>
  )
}