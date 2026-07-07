# EchoFlow

EchoFlow is a Chrome Manifest V3 browser extension MVP for capturing audio from the active tab, streaming it to a local development backend, and rendering bilingual subtitles in the page. The backend supports a `fake` (deterministic) speech provider for local development and tests, a Volcengine streaming ASR adapter (大模型流式语音识别 / sauc bigmodel), and a Volcengine translation adapter.

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

- Additional ASR streaming providers beyond Volcengine (`aliyun`, `tencent`).
- User accounts, login, server-side history, or sync.
- Text-to-speech playback.
- Muting or lowering original tab audio.
- Microphone input or system-wide audio capture.
- Search across history.
- Local STT or local translation models.

## Why localhost / self-host

EchoFlow runs a backend server on your own machine using your own ASR and translation provider credentials. The extension is hard-scoped to `127.0.0.1` and `localhost` — it cannot reach any remote server. Audio goes from your browser to your machine and nowhere else. Provider secrets stay in your backend environment files; the extension never sees them. This design means there are no EchoFlow-operated servers, no per-user accounts, and no data sent to the extension authors.

See [`docs/store-listing.md`](docs/store-listing.md) for the prepared Chrome Web Store listing draft (not yet published).

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

With these `fake` defaults the backend needs no credentials, so you can reach a full end-to-end demo (deterministic subtitles) out of the box. Real ASR and translation require Volcengine credentials — see [Provider Configuration](#provider-configuration) below; those secrets live only in the backend env file, never in the extension.

`PORT` is still accepted by the backend as a compatibility fallback when `ECHOFLOW_PORT` is not set.

### Provider Configuration

The backend separates ASR and translation providers because streaming recognition and text translation usually use different APIs and credentials.

ASR provider names:

- `fake` - deterministic local provider.
- `volcengine` - 大模型流式语音识别 (sauc bigmodel) streaming ASR over WebSocket. Requires `VOLCENGINE_ASR_APP_KEY` + `VOLCENGINE_ASR_ACCESS_KEY` (appid + access key — distinct from the translation `VOLCENGINE_API_KEY`).
- `aliyun`, `tencent` - reserved provider options; selecting one fails fast until implemented.

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

Volcengine streaming ASR environment (distinct credentials from translation):

```bash
ECHOFLOW_ASR_PROVIDER=volcengine
VOLCENGINE_ASR_APP_KEY=your-appid
VOLCENGINE_ASR_ACCESS_KEY=your-access-key
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
VOLCENGINE_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
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

## Install (prebuilt)

Non-developers can skip building the extension:

1. Open the project's [GitHub Releases](../../releases) and download the latest
   `echoflow-<version>-chrome.zip`.
2. Unzip it to a folder you'll keep (Chrome loads it from disk).
3. Go to `chrome://extensions`, enable **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.

This is an unpacked build (not a signed `.crx`), matching EchoFlow's self-host
model. The extension still needs the local backend running — see
[Setup](#setup) and [Development](#development) to start it (the default `fake`
providers need no credentials).

## Load the Extension in Chrome

1. Build the extension with `pnpm --filter @echoflow/extension build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select `apps/extension/.output/chrome-mv3`. The extension ships with an icon; the EchoFlow toolbar button appears immediately.
6. The setup wizard opens automatically on first install. Follow the three steps:
   - **Connect** — enter the backend URL (`http://127.0.0.1:8787`) and API key (`dev-key`), then click Connect.
   - **Languages** — pick your target language.
   - **Ready** — click Finish. The toolbar popup now starts and stops sessions; the subtitle overlay renders on the page.

If you need to revisit the wizard later, click **Finish setup** in the popup or **Run setup again** in the options page.

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

## License

EchoFlow is free and open source, permanently. The monorepo is licensed
per package: `packages/protocol` and `apps/extension` are **MIT** (build
compatible clients or backends freely); `apps/backend` is **AGPL-3.0-only**
(self-hosting is unrestricted; offering a modified backend as a network
service requires publishing your modifications). See the root
[`LICENSE`](LICENSE) for the full overview, and [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the DCO sign-off required on contributions.

"EchoFlow" and any associated logos are not covered by the code licenses;
do not use the name to suggest an official distribution or service.
