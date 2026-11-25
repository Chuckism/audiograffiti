import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { localTranscription } from './server/localTranscription';
export default defineConfig({
  plugins: [react(), localTranscription(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['thoughtsplat-mark.svg', 'icon.svg', 'icon-192.png', 'icon-512.png'],
    manifest: {
      name: 'ThoughtSplat', short_name: 'ThoughtSplat',
      description: 'Speak your thoughts. Organize your day.',
      theme_color: '#11131b', background_color: '#11131b', display: 'standalone', start_url: '/', scope: '/',
      icons: [{src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
        {src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]
    },
    workbox: {globPatterns:['**/*.{js,css,html,png,svg,woff2}'],navigateFallback:'/index.html',cleanupOutdatedCaches:true,runtimeCaching:[]}
  })],
  test: {include:['tests/unit/**/*.test.ts'],environment:'node'}
});
