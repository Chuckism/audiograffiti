# Acceptance and verification

## Automated coverage

Render preparation: 27 unit tests and the client/server production build passed. The compiled password-protected server also passed desktop and phone browser checks for authentication, recording, transcription with stubbed AI, transcript persistence, and offline PWA reopening. Live Render deployment remains pending account connection and environment settings.

Verified November 25, 2026: 23 unit tests and 20 browser tests across desktop and phone viewports passed for local transcription. Eight emulator tests and the server TypeScript build passed for the preceding cloud implementation. The client production build passed. A synthetic spoken sentence also passed through the real local transcription endpoint and OpenAI API. Cloud processing tests use stubbed AI responses; the deployed physical-device scenario below remains outstanding. The final voice-card color and label adjustment followed these checks; a separate visual check could not run because automatic approval review hit a usage limit.

Unit tests exercise:
- A thought remains a thought after a follow-up is scheduled.
- Ideas, tasks and fixed events have separate types.
- Adjacent time blocks are allowed; overlap across calendars is detected.
- Stale recommendations cannot overwrite another device's edit.
- Invalid AI reference IDs and unresolved questions cannot become commitments.
- Three independent overnight captures stay distinct.
- Offline outbox preservation and account separation.
- Lost text/upload acknowledgements retry with the same ID without duplicate writes.
- Active recordings are not submitted early.
- Device drafts move to an account only on explicit import; their item types and references survive the transfer.

Browser tests cover phone and desktop layouts:
- Phone opens Capture; desktop opens Today.
- Typed capture needs no categorization.
- A thought follow-up appears in Thoughts & To-dos, not Events.
- An event is rejected when it conflicts with a thought block.
- Suggestions require approval; original thoughts remain available.
- Installed static shell can reopen offline.
- A new workspace starts empty; typed thoughts appear immediately and survive reloading.
- Voice transcription appears after recording stops, survives reload, and preserves playable original audio.
- Failed transcription retains audio and can be retried from Today.
- Follow-ups persist without converting thoughts to tasks.
- Recorded audio survives reloading and remains downloadable from the collapsible device queue.
- Denied microphone access leaves typing available.
- An older tab blocking the storage upgrade does not erase typed text; safe reload restores it.

Firestore/Storage emulator tests verify:
- Own data is readable; other-account and anonymous reads/listing fail.
- Client cannot fabricate processing success, proposals, or confirmed items.
- Original capture text is immutable to the browser.
- Audio is private, type constrained, and cannot be overwritten.
- Review markers are accepted only on finished captures.
- Three submitted recordings produce distinct originals and pending proposals using existing workspace context.
- Duplicate job deliveries do not duplicate AI work or proposals.
- A failed AI step retains its transcript and retries without retranscribing.
- Expired worker leases recover; repeated failures stop at the retry limit.

## Mandatory cloud + physical device scenario

Do not mark this gate passed solely from demo/browser tests. Use a dedicated deployed backend, real AI credentials, and the same account on phone and desktop.

1. Seed a thought, project, task and fixed event. Record a new idea, a task update, and a follow-up request as three separate overnight captures.
2. Stop each recording without classifying it or reviewing suggestions.
3. Include one offline capture and interrupted upload. Reopen/reconnect; verify local state remains until acknowledgement.
4. Close the phone app after acknowledged upload. Confirm server work continues.
5. Open desktop. Verify all three originals and processing statuses, summaries and context-linked proposals.
6. Keep an idea as a thought. Approve its follow-up. Confirm it turns amber in Thoughts & To-dos while remaining a thought; removing the time returns it to purple.
7. Confirm proposed changes are not commitments until approved, including collective approval.
8. Edit on a second device. Confirm stale approval does not overwrite it.
9. Confirm another account cannot read recordings, transcripts, tasks, projects or recommendations.
10. Confirm calendar time, relative dates and DST transitions in the user's timezone.

## Phone test matrix: physical hardware still required

Test iOS Safari and installed Home Screen mode, plus Android Chrome and installed mode:
- first permission, denial/revocation, headset disconnect, phone call, screen lock;
- backgrounding, low power, termination, reopening offline;
- airplane mode, flaky network, successful upload with lost response;
- low storage and declined persistence; download recovery;
- three captures with different MIME containers and intelligible real speech;
- night brightness, keyboard access, safe areas and one-handed use.

Production rollout also requires a dedicated Firebase project, billing confirmation for backend services, authentication provider setup, bucket CORS, secrets, deployed rules/indexes/functions, and scheduler verification. Google/Outlook calendar synchronization is not implemented.
