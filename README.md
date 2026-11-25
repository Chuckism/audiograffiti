# ThoughtSplat preview · AudioGraffiti workspace

**Speak your thoughts. Organize your day.**

A simple, mobile-first home for thoughts and to-dos. A thought can remain a thought, including when you give it a follow-up time. Thoughts are purple until a follow-up time is set, then amber. Removing that time returns them to purple. To-dos are green and events blue, with labels and icons as well as color.

- **Capture:** one-tap voice recording, or type/paste without categorizing.
- **Today:** review original thoughts and suggestions at your own pace.
- **Calendar:** **Thoughts & To-dos** and **Events**, with shared conflict checking.
- **Saved:** find thoughts, to-dos, notes, projects, and original captures. Manual changes do not require AI.

The phone opens to Capture; desktop opens to Today. Installable PWA support, dark default theme, optional light theme.

## Run locally

Node **22.12+** is required. On Windows PowerShell, use npm.cmd if the npm PowerShell shim drops forwarded arguments.

```sh
npm ci
cd functions
npm ci
cd ..
npm run dev
```

Without Firebase configuration, the app opens an **empty device workspace**. Your own text, recordings, thoughts, to-dos, and calendar drafts persist in IndexedDB across reloads. They are explicitly marked as device-only and are not cloud-synced or automatically organized. After cloud setup and sign-in, use **Move drafts to my workspace** to bind them to that account. Originals upload first; project/item drafts follow. Copies remain until the server acknowledges them, with failed imports available for retry or download.

For voice-to-text in the local development preview, set the server-only `OPENAI_API_KEY` in `.env.local` and run `npm run dev`. The local Node endpoint sends audio to OpenAI for transcription, keeps the key out of the browser, and accepts only requests from the loopback preview. After stopping a recording, its transcript appears in Capture, Today, and Saved; audio and text remain on this device. Previously saved recordings are picked up when the app reopens. Failed transcription retains the audio and offers Retry. This local helper does not provide cloud sync or organizational suggestions, and is not included in static hosting or `npm run preview`; production uses the Firebase worker.

The optional ?demo=1 URL opens the separate illustrative workspace used by browser tests. Its sample planning changes reset on refresh. It is no longer the default. ThoughtSplat is the current preview wordmark; the repository and cloud identifiers remain AudioGraffiti.

Copy .env.example to .env.local and fill in a **separate AudioGraffiti Firebase project's** web settings to enable the real workspace. Existing non-VITE secrets are not included in the client bundle. Never put AI keys in VITE variables or public files.

## Cloud setup

For phone testing over HTTPS, use the [private Render preview setup](docs/RENDER.md). It includes hosted transcription while retaining device-only drafts until the Firebase setup below is completed.

There is intentionally no production .firebaserc target. This app does not connect to, deploy over, or reuse IssueTrax's live data.

1. Create/select a dedicated Firebase project. Enable email/password and Google authentication; register the hosting domain.
2. Create a default Firestore database and Storage bucket in us-central1. Cloud Functions, scheduled recovery, and Storage require the appropriate billing plan. Confirm project and billing before deployment.
3. Set public web config in .env.local; keep VITE_USE_EMULATORS=false for a real workspace.
4. Install function dependencies and set the server secret:

```sh
firebase functions:secrets:set OPENAI_API_KEY --project YOUR_AUDIOGRAFFITI_PROJECT
npm run build
firebase deploy --only firestore,storage,functions,hosting --project YOUR_AUDIOGRAFFITI_PROJECT
```

Deployment prompts for ASSIMILATION_MODEL (default gpt-4o-mini). Transcription uses whisper-1. The AI key and processing remain on the server. Align the function event region and bucket region.

Authenticated playback uses Firebase Storage getBlob. Configure bucket CORS for actual application origins using storage.cors.example.json. Do not use public download links for recordings. Keep recovery scheduler enabled. Set budget alerts and review Firebase quotas before opening registration.

## Verification

```sh
npm test
npm run build
npm run functions:build
npm run test:browser
npm run test:rules
```

Browser tests use installed Microsoft Edge with desktop and phone viewports against the compiled PWA. Adjust the channel in playwright.config.ts for another browser.

Rules tests use **demo-audiograffiti**, never a live project, and require Firebase CLI and **Java 21+**. They exercise real Firestore/Storage emulators. See [acceptance testing](docs/ACCEPTANCE.md) for the mandatory overnight scenario and physical-device checks.

## Foundation and limits

React/Firebase initialization and authentication patterns were adapted from the local IssueTrax project. Team approval, team-shared data, chat, issue phases, fix workflows, and the prior audiogram/payment screens are absent from this product. The original IssueTrax checkout and backend were not changed.

For a connected workspace, Firestore and private Storage are authoritative. IndexedDB retains pending captures and explicitly imported device drafts until the server acknowledges them. Before cloud setup, the app clearly labels its separate device-only workspace. Upload retries preserve the same capture ID; originals are retained. Server jobs use transaction leases, bounded retries, deterministic proposal IDs, and scheduled recovery. Approvals and calendar edits check versions and conflicts transactionally.

MVP limits: 5 minutes / 20 MiB per recording; 20,000 characters per text capture; 500 saved items; 12 suggestions per capture. Originals are paged; up to 200 pending suggestions load at a time. AI considers 150 recent saved items with bounded context excerpts. Google/Outlook calendar connections are not implemented.

A PWA cannot guarantee recording/upload continuation after OS suspension. Once upload is acknowledged, server work continues without the phone. Read the [mobile evaluation](docs/MOBILE_EVALUATION.md) before marking mobile acceptance complete.
