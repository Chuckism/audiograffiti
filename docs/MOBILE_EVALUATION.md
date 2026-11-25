# PWA and native evaluation

Evaluated November 25, 2026. Decision: implement an installable PWA and a durable server pipeline, with an explicit physical-device release gate. A responsive website alone does not satisfy the product requirement.

## Implemented

- Installable manifest, standalone display, home-screen icons, cached static application shell and local fonts.
- One-tap microphone start after any OS permission prompt. MediaRecorder probes supported formats rather than labeling every recording WAV.
- Stop saves automatically. No transcript/recommendation review is required.
- Account-bound IndexedDB outbox; periodic recording snapshots; local-only state until acknowledged upload.
- One-second dataavailable snapshots, serialized so an old write cannot replace a newer/final recording. The interval is a browser request, not a guaranteed durability deadline.
- Stop and preserve received audio when the app hides or the microphone is interrupted. Incomplete recordings can be recovered or downloaded after reopening. Storage failures offer download recovery rather than claiming success.
- Retry on online/focus and while open. Stable capture/object IDs prevent duplicates after lost acknowledgements.
- Server transcription, organization, bounded retry, lease recovery and atomic approvals continue independently after submission.
- Capture page defaults on narrow screens; large touch targets, 16px inputs, safe-area navigation, reduced-motion support, dark and light themes.

## Limits that affect the promise

Microphone capture requires a secure context and user permission. A first visit cannot bypass permission prompts. [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Safari can pause its microphone; Android screen locking can delay recording chunks. Force termination can lose audio the browser has not delivered, even with IndexedDB snapshots. [MDN MediaRecorder dataavailable](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event).

Background Sync is not a cross-browser baseline. This app does not depend on it for successful upload. An unsent capture can require reopening the app; closing before acknowledgement is not equivalent to completed upload. [MDN Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API).

IndexedDB is device storage, not cloud durability. WebKit storage quotas, pressure and eviction apply. Storage persistence is requested, but the browser decides whether to grant it. Private browsing and clearing site data can remove unsent thoughts. [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

Neither Firebase realtime synchronization nor a home-screen icon overrides these operating-system limits.

## Native decision gate

If the promise includes closing/locking the phone before upload completes and expecting reliable deferred upload without reopening, native capture is the recommended next implementation. Keep Firebase identity, private paths, capture IDs and the server pipeline; add a native filesystem outbox and platform upload jobs.

A React Native client is a reasonable path because the team uses TypeScript/React. It still needs native recording/background transfer modules, interruption handling, native persistence, and physical-device tests. A web-view wrapper alone does not remove the limitation.

- iOS: file-backed recording with interruption handling and background URLSession file uploads. OS/user force-quit restrictions still need honest handling. [Apple background file transfers](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).
- Android: native audio capture, applicable foreground-service lifecycle, and WorkManager for persistent deferred upload. [Android persistent work](https://developer.android.com/develop/background-work/background-tasks/persistent-work).

Keep this decision open until acceptance passes on real iOS and Android hardware. Browser device emulation verifies layouts and web flows, not operating-system recording behavior.
