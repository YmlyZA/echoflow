# EchoFlow — Chrome Web Store Listing Draft

> Status: **not yet submitted**. The localhost / self-host distribution model is
> not eligible for the Chrome Web Store today. This draft is ready for when
> public distribution becomes viable.

---

## Name

EchoFlow

---

## Short description (≤ 132 characters)

```
Real-time bilingual subtitles for any browser tab's audio — powered by your own self-hosted backend.
```

Character count: **100** (limit 132).

---

## Detailed description

EchoFlow overlays live bilingual subtitles directly on your browser tab — source text on top, translation beneath — without touching the audio you hear or requiring a cloud service account.

**How it works**

1. Click the EchoFlow toolbar icon to start a session on the active tab.
2. The extension captures the tab's audio stream and forwards it — as raw 16 kHz PCM — to a backend server running on your own machine.
3. The backend transcribes the speech with a streaming ASR provider and translates each finalised segment with a translation provider.
4. Recognised text and its translation appear as a floating subtitle overlay, styled for readability and isolated in a shadow root so the host page's CSS cannot interfere.
5. Click the toolbar icon again to stop. Every finalised subtitle is saved to local browser history for later review or export.

**Self-host model**

You run the backend. EchoFlow ships a Node.js server (`apps/backend`) that you start on your machine with your own provider credentials. The extension is hard-scoped to `127.0.0.1` and `localhost`; it cannot reach any remote server. Nothing is sent to the extension authors.

**Two subtitle modes**

| Mode | Chinese label | When to use |
|------|--------------|-------------|
| Free pipeline | 一致 | Standard streaming ASR + translation. Works with the included `fake` deterministic provider for development, or with Volcengine credentials for live use. |
| Interpret | 实时 | Simultaneous-interpretation path via Volcengine AST. Requires separate AST credentials. Produces mixed delta / cumulative subtitle lines. |

**First-run setup**

After loading the extension a setup wizard opens automatically. Three steps: connect (enter your backend URL and API key), pick your target language, and you are ready. The toolbar popup starts and stops sessions; the subtitle overlay appears on the page.

---

## Category and language

- **Category:** Accessibility (or Productivity)
- **Primary language:** English

---

## Permission justifications

Each permission is the minimum required for the feature it enables.

| Permission | Why it is needed |
|-----------|-----------------|
| `activeTab` | Act on the specific tab the user starts capture on; no access to other tabs. |
| `tabCapture` | Capture the active tab's audio stream so it can be sent to the backend. |
| `storage` | Persist your backend URL, API key, target language, and font-size preference; store local subtitle history. |
| `offscreen` | Run `getUserMedia` and the PCM audio pipeline in an offscreen document — the only place Chrome MV3 allows `getUserMedia` outside a visible page. |
| `scripting` | Inject the subtitle overlay content script into the page on demand when a session starts; removed when the session stops. |
| `host_permissions`: `http://127.0.0.1/*`, `http://localhost/*` | The extension talks only to your own local backend. These two patterns cover the default port (`8787`) and any port you configure. No external hosts are permitted. |

---

## Privacy

- **Audio:** Tab audio is streamed over a local WebSocket to a server running on your own machine. It goes nowhere else.
- **No extension-author servers:** EchoFlow has no cloud backend, no relay, and no analytics endpoint operated by the extension authors.
- **No telemetry:** No usage data, crash reports, or identifiers are collected or transmitted.
- **Local storage only:** Settings (backend URL, API key, target language, font size) and subtitle history are stored in the browser with the `storage` permission. They are never synced to or read by any remote server.
- **Provider credentials:** ASR and translation provider secrets live only in your backend's environment files. The extension never sees or stores them.

---

## Screenshot capture guide

> This is a **manual follow-up** step. The shots below cannot be automated because
> they require a real toolbar click that grants `activeTab`/`tabCapture` — a
> Chrome gesture that headless Playwright cannot reproduce.

### Target size

**1280 × 800 px** (standard Chrome Web Store screenshot size).

### Shots to capture

| # | Shot | Surface to show |
|---|------|----------------|
| 1 | Onboarding — Connected | Setup wizard after entering the backend URL and clicking Connect; the green "Connected" confirmation visible. |
| 2 | Popup — live session | Toolbar popup open with a session running: timer visible, Stop button active. |
| 3 | Overlay on a video | A YouTube or HTML5 video page with the EchoFlow subtitle strip rendered over it — source language line + translated line. |
| 4 | Options page | Full options/settings page showing URL, API key (masked), language selector, and font-size control. |

### How to capture

1. Build the extension: `pnpm --filter @echoflow/extension build`
2. Start the backend: `pnpm --filter @echoflow/backend dev`
3. Open `chrome://extensions` → Enable Developer mode → Load unpacked → select `apps/extension/.output/chrome-mv3`.
4. The setup wizard opens automatically. Complete it (URL `http://127.0.0.1:8787`, key `dev-key`). **Take shot 1** at the Connected confirmation screen.
5. Navigate to a tab with audio (e.g. a YouTube video, or any page with the HTML5 audio element).
6. Click the EchoFlow toolbar icon to start a session. Once the overlay appears, **take shot 3** (overlay on the video).
7. While the session is running, click the toolbar icon again to open the popup. **Take shot 2** (popup live state).
8. Click the "Open full settings" link in the popup footer, or navigate to the options page via `chrome://extensions`. **Take shot 4** (options page).
9. Resize or crop each capture to exactly 1280 × 800 before uploading.

---

## Status note

This listing draft is prepared but **not submitted**. The Chrome Web Store requires
extensions that communicate with remote servers to justify that communication; the
current localhost / self-host model — where the backend runs on the user's own
machine — does not map cleanly to the Store's standard review criteria for
network-using extensions. The draft is ready for review and submission once a
viable public distribution path (e.g. bundled installer, hosted backend option,
or policy-exempted distribution) is in place.
