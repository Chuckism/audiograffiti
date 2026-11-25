import { loadEnv, type Plugin } from 'vite';
import { transcriptionMiddleware } from './transcription.js';
export { transcriptionMiddleware } from './transcription.js';

export function localTranscription(): Plugin {
  return {
    name: 'thoughtsplat-local-transcription', apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir, 'OPENAI_');
      server.middlewares.use(transcriptionMiddleware(process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || ''));
    }
  };
}
