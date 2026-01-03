// Generate voice samples for all 9 Scenaryoze characters
// Run with: node generate-character-samples.js

const fs = require('fs');
const path = require('path');

const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY;

if (!FISH_AUDIO_API_KEY) {
  console.error('ERROR: FISH_AUDIO_API_KEY environment variable not set');
  process.exit(1);
}

// Character voice mappings
const CHARACTERS = {
  shawn: {
    id: '536d3a5e000945adb7038665781a4aca',
    name: 'Shawn',
    intro: "Hi, I'm Shawn. I bring professionalism and clarity to every training scenario."
  },
  chuck: {
    id: 'ccbc13d6002a46b7883f607fd8fe0516',
    name: 'Chuck',
    intro: "Hey there, I'm Chuck. I make complex topics easy to understand and engaging."
  },
  max: {
    id: '37a48fabcd8241ab9b69d8675fb1fe13',
    name: 'Max',
    intro: "Hello, I'm Max. I excel at delivering confident, authoritative training content."
  },
  boomer: {
    id: 'ba24f05b17644498adb77243afd11dd9',
    name: 'Boomer',
    intro: "Greetings, I'm Boomer. I bring experience and wisdom to leadership scenarios."
  },
  brittany: {
    id: '2a9605eeafe84974b5b20628d42c0060',
    name: 'Brittany',
    intro: "Hi everyone, I'm Brittany! I specialize in friendly, approachable customer service training."
  },
  kaitlyn: {
    id: 'da8ae28bb18d4a1ca55eccf096f4c8da',
    name: 'Kaitlyn',
    intro: "Hello, I'm Kaitlyn. I bring warmth and authenticity to every interaction."
  },
  sage: {
    id: '933563129e564b19a115bedd57b7406a',
    name: 'Sage',
    intro: "Hi there, I'm Sage. I create calm, professional environments for effective learning."
  },
  randy: {
    id: 'bf322df2096a46f18c579d0baa36f41d',
    name: 'Randy',
    intro: "Hey, I'm Randy. I deliver energetic, engaging training that keeps teams motivated."
  },
  coral: {
    id: 'e107ce68d2a64e928c3a674781ce9d56',
    name: 'Coral',
    intro: "Hello! I'm Coral. I bring enthusiasm and positivity to customer-facing scenarios."
  }
};

async function generateSample(character, voiceId, text) {
  console.log(`Generating sample for ${character}...`);
  
  try {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        reference_id: voiceId,
        model: 's1',
        format: 'mp3',
        normalize: false,
        latency: 'normal'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fish Audio API error for ${character}: ${response.status} - ${errorText}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const outputPath = path.join(__dirname, `sample-${character}.mp3`);
    fs.writeFileSync(outputPath, audioBuffer);
    
    console.log(`✅ ${character}: ${audioBuffer.length} bytes → ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to generate ${character}:`, error.message);
    return false;
  }
}

async function generateAllSamples() {
  console.log('🎙️  Generating voice samples for all 9 characters...\n');
  
  const results = [];
  
  for (const [key, data] of Object.entries(CHARACTERS)) {
    const success = await generateSample(data.name, data.id, data.intro);
    results.push({ character: data.name, success });
    
    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n📊 Summary:');
  console.log(`✅ Successful: ${results.filter(r => r.success).length}`);
  console.log(`❌ Failed: ${results.filter(r => !r.success).length}`);
  
  if (results.every(r => r.success)) {
    console.log('\n🎉 All character samples generated successfully!');
    console.log('📁 Files saved to current directory as sample-*.mp3');
  }
}

// Run the generator
generateAllSamples().catch(console.error);