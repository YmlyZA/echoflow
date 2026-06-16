# EchoFlow

EchoFlow is a Chrome Manifest V3 browser extension MVP for capturing audio from the active tab, streaming it to a local development backend, and rendering bilingual subtitles in the page. The current backend uses fake speech providers for deterministic development and tests, with provider configuration in place for adding domestic ASR vendors and a Volcengine translation adapter.

## MVP Scope

In scope:

- Capture active-tab audio after a user gesture.
- Preserve normal tab audio playback while capturing.
- Stream audio to a configured backend WebSocket endpoint.
- Render bilingual source and translated subtitles on the page.
- Store finalized subtitle history locally in the browser.
- Export local history as text or JSON.
- Configure backend URL, API key, target language, and display preferences.

Out of scope:

- Real ASR streaming providers.
- User accounts, login, server-side history, or sync.
- Text-to-speech playback.
- Muting or lowering original tab audio.
- Microphone input or system-wide audio capture.
- Search across history.
- Local STT or local translation models.

## Setup

Install dependencies:

```bash
pnpm install
```

Optional local environment file:

```bash
cp .env.example .env
```

The development defaults are:

- `ECHOFLOW_API_KEY=dev-key`
- `ECHOFLOW_PORT=8787`
- `ECHOFLOW_ASR_PROVIDER=fake`
- `ECHOFLOW_TRANSLATION_PROVIDER=fake`

`PORT` is still accepted by the backend as a compatibility fallback when `ECHOFLOW_PORT` is not set.

### Provider Configuration

The backend separates ASR and translation providers because streaming recognition and text translation usually use different APIs and credentials.

ASR provider names:

- `fake` - deterministic local provider, currently the only implemented ASR provider.
- `volcengine`, `aliyun`, `tencent` - reserved domestic provider options. Selecting one currently fails fast with a clear startup/runtime error until the matching streaming WebSocket adapter is implemented.

Translation provider names:

- `fake` - deterministic local provider.
- `volcengine` - calls the Volcengine machine translation large-model API over HTTPS.
- `aliyun`, `tencent` - reserved provider options.

Volcengine translation environment:

```bash
ECHOFLOW_TRANSLATION_PROVIDER=volcengine
VOLCENGINE_API_KEY=your-api-key
VOLCENGINE_TRANSLATION_ENDPOINT=https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate
VOLCENGINE_TRANSLATION_RESOURCE_ID=volc.speech.mt
```

Keep provider credentials only in backend environment files. Do not put provider secrets into the browser extension.

## Development

Start the backend:

```bash
pnpm --filter @echoflow/backend dev
```

The backend exposes a health check at `/healthz` (there is no `/health` route):

```bash
curl http://127.0.0.1:8787/healthz   # expects {"ok":true}
```

Start the WXT extension dev server:

```bash
pnpm --filter @echoflow/extension dev
```

Build the extension:

```bash
pnpm --filter @echoflow/extension build
```

The Chrome MV3 build output is written to:

```text
apps/extension/.output/chrome-mv3
```

The extension captures tab audio as 16 kHz/16-bit/mono PCM (via an AudioWorklet) so the backend can feed it to any streaming ASR provider.

## Load the Extension in Chrome

1. Build the extension with `pnpm --filter @echoflow/extension build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select `apps/extension/.output/chrome-mv3`.
6. Open the extension options page and set the backend URL to `http://127.0.0.1:8787` and the API key to `dev-key`.

## Test and Verification Commands

Run the full workspace build:

```bash
pnpm build
```

Run all unit tests:

```bash
pnpm test
```

Run type checks:

```bash
pnpm typecheck
```

Run lint checks:

```bash
pnpm lint
```

Run the end-to-end smoke test:

```bash
bash scripts/dev-smoke.sh
```

The smoke script starts a local backend, builds/loads the extension in headless Chromium, seeds extension settings, verifies the backend health check, and exercises the extension startup path. Headless automation cannot fully reproduce a real toolbar click that grants Chrome's `activeTab` and `tabCapture` privileges, so the smoke test records that synthetic extension-action limitation while still validating the deterministic parts of the flow.
