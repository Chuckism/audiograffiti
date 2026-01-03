import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req) {
  try {
    const { problemDescription } = await req.json();
    
    if (!problemDescription?.trim()) {
      return NextResponse.json(
        { error: "Problem description is required" },
        { status: 400 }
      );
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert L&D professional creating realistic 3-minute training scenarios.

RULES:
- Generate a 2-person dialogue (450-600 words total)
- Use ONLY these characters: SHAWN and BRITTANY
- Format each line as: [CHARACTER]: dialogue text
- SHAWN speaks first
- Natural conversation with realistic speech patterns
- Focus on ONE clear learning objective
- End with successful resolution

OUTPUT FORMAT:
Title: [Clear Title]

[SHAWN]: [First line]
[BRITTANY]: [Response]
[SHAWN]: [Next line]
...`
        },
        {
          role: "user",
          content: `Create a training scenario for this problem:\n\n"${problemDescription}"`
        }
      ],
      temperature: 0.8,
      max_tokens: 1500,
    });

    const rawScenario = completion.choices[0].message.content;
    
    const lines = rawScenario.split('\n').filter(line => line.trim());
    const titleLine = lines.find(line => line.toLowerCase().startsWith('title:'));
    const title = titleLine 
      ? titleLine.replace(/^title:\s*/i, '').trim() 
      : 'Training Scenario';
    
    const dialogue = [];
    
    for (const line of lines) {
      const match = line.match(/^\[?([A-Z][A-Z\s\-]*)\]?:\s*(.+)$/);
      if (match) {
        const character = match[1].trim().toUpperCase();
        const text = match[2].trim();
        
        if ((character === 'SHAWN' || character === 'BRITTANY') && text.length > 0) {
          dialogue.push({
            character,
            text,
            voice: character.toLowerCase()
          });
        }
      }
    }

    if (dialogue.length < 6) {
      throw new Error('Generated scenario too short');
    }

    const wordCount = dialogue.reduce((sum, d) => sum + d.text.split(/\s+/).length, 0);

    const segments = dialogue.map(line => ({
      text: line.text,
      voice: line.voice
    }));

    return NextResponse.json({
      success: true,
      title,
      dialogue,
      segments,
      wordCount
    });

  } catch (error) {
    console.error('Scenario generation failed:', error);
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Scenario generation failed'
      },
      { status: 500 }
    );
  }
}