# Browser Tab Audio Translation Extension Design

Date: 2026-05-31

## Goal

Build a Chrome/Chromium browser extension MVP that captures the current tab's audio, performs cloud-based real-time speech recognition and translation, and displays bilingual subtitles on the page.

The MVP focuses on tab audio only. Microphone input and system audio are explicitly future extensions and should be supported by the architecture without being implemented in the first version.

## MVP Scope

In scope:

- Capture audio from the active browser tab after a user gesture.
- Preserve normal tab audio playback while capturing.
- Stream audio to a configured cloud backend.
- Receive real-time speech recognition and translation events.
- Display bilingual subtitles as two lines: source text first, translation second.
- Auto-detect source language on the backend.
- Default target language from the browser language, with manual override.
- Store finalized subtitle history locally in the browser.
- Export local history as text or JSON.
- Configure backend URL and API key in the extension.

Out of scope for MVP:

- User accounts and login.
- Server-side history storage or sync.
- Text-to-speech playback.
- Muting or lowering original tab audio.
- Microphone input.
- System-wide audio capture.
- Search across history.
- Local STT or local translation models.

## Chosen Approach

Use a Chrome Manifest V3 extension with `tabCapture`, an offscreen document, a page overlay, and a cloud WebSocket backend.

The extension owns capture and presentation. The backend owns source language detection, speech recognition, translation, and provider integration. The protocol between extension and backend should remain stable so the backend can change STT or translation providers without changing the extension.

This approach is preferred because it fits the MVP tightly, gives the best path to real-time quality, and keeps future microphone, system audio, TTS, and server-side history extensions cleanly separated.

## Architecture

The system has three layers:

1. Chrome extension
2. Cloud real-time processing service
3. Local browser history storage

The Chrome extension contains:

- Background service worker: coordinates extension actions, tab capture setup, state, and messaging.
- Offscreen document: consumes the captured tab `MediaStream`, keeps tab audio audible, encodes or chunks audio, and streams it to the backend.
- Content script: injects the page subtitle overlay and receives subtitle events.
- Settings/history page: manages backend configuration, target language, display preferences, and local history.
- Storage layer: persists settings and finalized session history.

The backend contains:

- WebSocket session endpoint.
- Audio frame receiver.
- STT provider adapter.
- Translation provider adapter.
- Language detection handling.
- Subtitle event emitter.

## Chrome Extension Flow

The user clicks the extension button on a target tab.

If the extension is not configured, it opens the settings page. If configured, the background service worker starts a subtitle session for the current tab, requests tab audio capture, creates or reuses the offscreen document, and sends the stream identifier and session configuration to it.

The offscreen document resolves the stream, connects it to an `AudioContext` so the original tab audio remains audible, and sends audio chunks to the backend over WebSocket.

The content script injects a Shadow DOM overlay into the page. It renders the latest bilingual subtitle segment and controls such as stop, hide, drag, and font size.

When the session stops, the extension closes the WebSocket, finalizes the local session metadata, and leaves only finalized subtitle segments in history.

## Backend Protocol

The extension sends a WebSocket session request with:

- API key
- Session ID
- Tab title and URL
- Target language
- Audio format metadata
- Optional client capabilities

Audio frames are sent as binary frames or structured messages, depending on the selected transport implementation. The protocol should keep audio and control events distinct.

The backend sends subtitle events:

```json
{ "type": "partial", "segmentId": "s1", "sourceText": "hello every", "translatedText": "你好，每" }
```

```json
{ "type": "final", "segmentId": "s1", "sourceText": "hello everyone", "translatedText": "大家好" }
```

```json
{ "type": "language", "sourceLanguage": "en", "targetLanguage": "zh-CN" }
```

```json
{ "type": "error", "code": "stt_unavailable", "message": "Speech recognition provider unavailable" }
```

`partial` events update the current subtitle in place. `final` events lock a segment and write it to local history. `language` events update the UI's detected language label. `error` events are displayed briefly and written to session metadata.

## Subtitle Model

Each subtitle segment has:

- `sessionId`
- `segmentId`
- `startTimeMs`
- `endTimeMs`
- `sourceLanguage`
- `targetLanguage`
- `sourceText`
- `translatedText`
- `confidence`
- `status`

Only finalized segments are stored in local history. Partial text is ephemeral and should not pollute saved records.

The overlay displays each segment as two lines:

1. Source text
2. Translated text

Translation may lag recognition. If source text exists but translation is not ready, the first line should update immediately while the second line keeps the latest available translation state.

## UI Design

The extension button is the main start/stop control. Badge or popup state should show:

- Not configured
- Connecting
- Running
- Error

The page overlay appears near the bottom center by default. It uses fixed positioning, high z-index, and Shadow DOM style isolation. It should be draggable, closable, temporarily hideable, and support basic font size adjustment.

The overlay should not include long instructions. It should prioritize subtitles and compact controls.

The settings/history page contains:

- Backend server URL
- API key
- Target language default and manual override
- Subtitle display preferences
- Local session history
- Export as `.txt`
- Export as `.json`

The target language default comes from `navigator.language`, but the user can override it.

## Local History

Local history is stored in browser storage, preferably IndexedDB for session records and subtitle segments. Chrome storage can hold lightweight settings.

Each local session stores:

- Local session ID
- Optional future remote session ID
- `syncStatus` value reserved for future sync
- Tab title
- Tab URL
- Start time
- End time
- Source language
- Target language
- Final subtitle segments
- Error metadata

Server-side history is not implemented in MVP, but the data model reserves `remoteSessionId` and `syncStatus` so later sync can map local sessions to backend records.

## Permissions

Use the minimum required Chrome extension permissions:

- `tabCapture` for tab audio capture.
- `offscreen` for Manifest V3 offscreen audio processing.
- `storage` for settings and history.
- `activeTab` or narrowly scoped host access for current-page overlay injection.

Content scripts should be injected only when a session starts, not by default on every page.

The minimum supported Chrome version should be chosen to match stable support for service worker to offscreen document stream handling.

## Error Handling

Configuration errors:

- Missing backend URL or API key opens the settings page.
- Invalid backend URL blocks session start.

Capture errors:

- Non-capturable pages, missing user gesture, permission failure, or tab close should stop the session and show a short overlay error.

Connection errors:

- WebSocket disconnects should retry a limited number of times.
- If reconnection fails, the session stops and finalized history remains available.

Processing errors:

- STT errors can stop recognition for the session or continue if recoverable.
- Translation errors should not block source text display.
- Backend `error` events should be recorded in session metadata.

Lifecycle errors:

- If the offscreen document is unavailable or crashes, the background service worker should recreate it when possible.
- If the content script cannot inject, the session should fail cleanly instead of streaming audio without visible output.

## Testing Strategy

Extension unit tests:

- Subtitle event reducer.
- Partial-to-final segment handling.
- Settings validation.
- Target language default selection.
- History persistence and export formatting.

Extension integration tests:

- Overlay injection into a test page.
- Drag, hide, stop, and font size controls.
- Mock WebSocket subtitle event rendering.
- Finalized history write after `final` events.

Offscreen audio pipeline tests:

- Mock `MediaStream` handling.
- WebSocket frame sending.
- Session start and stop cleanup.
- Audio playback preservation path.

Backend tests:

- WebSocket session authorization.
- Audio frame ingestion.
- Fake STT and fake translation provider adapters.
- `partial`, `final`, `language`, and `error` event order.
- Disconnect cleanup.

End-to-end smoke test:

- A local test page plays known audio.
- The extension captures the tab.
- A test backend returns deterministic subtitle events.
- The overlay renders bilingual subtitles.
- Final segments are written to local history.

## Future Extensions

Microphone input:

- Add a new `AudioSourceProvider` that uses microphone capture.
- Reuse backend protocol, subtitle reducer, overlay, and history model.

System audio:

- Add a desktop capture or native host based source provider, depending on platform constraints.
- Reuse the same session and subtitle model.

TTS and audio control:

- Add TTS output after translation.
- Add original audio mute or volume reduction controls in the offscreen audio pipeline.
- Keep these disabled in MVP.

Server-side history:

- Add login or API-key-associated identity.
- Sync finalized local sessions to backend records.
- Use `remoteSessionId` and `syncStatus` already present in the local model.

Local processing:

- Add pluggable local STT or translation engines later behind the same processing interface.
- Keep cloud processing as the MVP default.

## External References

- Chrome `tabCapture` API: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome `offscreen` API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome audio recording and screen capture guidance: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture

## Open Constraints

The concrete STT and translation providers are intentionally not selected in this design. The backend must expose a provider-neutral WebSocket protocol so provider selection can happen during implementation planning without changing the extension boundary.

The exact audio frame format is also deferred to implementation planning. The MVP should choose the simplest format that works reliably with the selected backend provider while preserving the protocol boundary.
