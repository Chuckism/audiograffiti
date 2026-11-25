# ThoughtSplat private mobile preview on Render

This deploys the current thought capture app with hosted voice-to-text at an HTTPS address suitable for phone microphone access. It does not yet connect the Firebase workspace: recordings, transcripts, and calendar drafts remain separate on each device. The original desktop localhost data also belongs to a different browser origin and will not appear at the Render address.

## Deploy

Use a Render **Web Service**, not a Static Site. The checked-in `render.yaml` configures:

- Repository: `Chuckism/audiograffiti`.
- Branch: `codex/thoughtsplat-mobile-workspace`.
- Service name: `thoughtsplat-preview` (Render may require a unique variation).
- Build: `npm ci --include=dev && npm run build`.
- Start: `npm start`.
- Health check: `/healthz`.
- Plan: Free, for personal testing.

Create a Blueprint from this repository and branch, then provide these values in Render's secret environment settings:

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | Your server-side transcription key. Never use a `VITE_` prefix. |
| `PREVIEW_PASSWORD` | A unique password of at least 16 characters. |
| `PREVIEW_USERNAME` | `preview`, already supplied by the Blueprint. |

Render supplies `PORT` and `RENDER_EXTERNAL_URL`. The server binds to `0.0.0.0` and uses that external HTTPS origin. If adding a custom domain later, set `PUBLIC_ORIGIN` to its exact HTTPS origin.

After the deploy succeeds, open the URL shown by Render in Safari on iPhone or Chrome on Android. Enter username `preview` and the password configured above. Allow microphone access, record a short thought, and stop. Check that its text appears, reload, and listen to the original from Saved. Add a follow-up, then remove its time to verify amber returns to purple. You can add the app to your home screen.

The password protects both the preview and the paid transcription endpoint. The server serves only the compiled `dist` folder, rejects cross-origin transcription requests, bounds recording size and concurrency, and does not write recordings to Render's filesystem. The endpoint keeps short-lived deduplication results in memory; each device retains its audio until a successful transcript is saved locally. This is a testing gate, not the final per-user authentication system.

## Limits and next step

Render's free web service sleeps after 15 minutes without inbound traffic, so the first visit may take longer. See [Render's free-service limits](https://render.com/docs/free). The configured OpenAI account is still billed for transcription usage.

Complete the dedicated Firebase setup in the main README before inviting users who expect phone-to-desktop synchronization. Do not connect this preview to IssueTrax's production data.

For a local production-server check, build the app, set `PREVIEW_PASSWORD`, `PUBLIC_ORIGIN=http://127.0.0.1:10000`, and optionally `OPENAI_API_KEY` in the server environment, then run `npm start`. This command does not automatically read `.env.local`. The usual `npm run dev` workflow continues to read it for the loopback development helper.
