# Adding a speech or translation provider

EchoFlow's backend talks to ASR and translation vendors through two small,
provider-neutral interfaces. This guide is for anyone who wants to add an
adapter for a vendor they use. First-party we keep two lanes working — Volcengine
and OpenAI-compatible — and rely on contributors for the rest, because an
adapter can only be kept honest by someone who runs it with real credentials.

## The contract

Both interfaces live in `apps/backend/src/providers/types.ts`.

**Speech.** The extension always sends 16 kHz / 16-bit signed LE / mono PCM
(`pcm_s16le`) in ~100 ms frames. An adapter turns that stream into segment
events:

```ts
type SpeechProvider = {
  open(opts: {
    onSegment: (event: SegmentEvent) => void;   // language | partial | final
    onError?: (error: Error) => void;
    onStatus?: (state: "reconnecting" | "live") => void;
  }): SpeechRecognitionStream;                  // pushFrame / end / close
};
```

Rules the session layer relies on:

- Emit one `language` event first (use `"auto"` if the vendor does not report it).
- `final` events must be **sentence-sized and monotonic**: one per confirmed
  utterance, `segmentId` strictly increasing (`seg-1`, `seg-2`, …), `startTimeMs`
  / `endTimeMs` relative to the start of the stream. The extension aligns these
  times to the page video, so they must be real, not zero.
- `partial` is optional. Volcengine skips partials entirely and only surfaces
  confirmed sentences; that is a valid, movie-style choice.
- `end()` resolves once the trailing final has arrived or a bounded timeout
  passes (`createDrainGate`). `close()` is idempotent and must cancel the drain.
- No audio may be sent after `end()`; `pushFrame` after `close()` is a no-op.

**Translation.** Stateless request/response:

```ts
type TranslationProvider = {
  translate(input: { text; sourceLanguage; targetLanguage }): Promise<string>;
  close(): Promise<void> | void;
};
```

`sourceLanguage` may be `"auto"`. Language codes on this side are BCP-47
(`zh-CN`, `zh-TW`, `en`, `ja`, …); map to the vendor's spelling inside the
adapter (see `toVolcengineLanguageCode`). A thrown error is **non-fatal**: the
session emits the line untranslated plus a `translation_failed` event and keeps
going, so throw freely on HTTP/JSON failures rather than returning `""`.

## Touch points

An adapter is wired in five places. Keep them in one PR so the fail-fast and
capabilities story stays consistent.

| Step | File | What |
|---|---|---|
| 1 | `providers/providerConfig.ts` | Add the name to `ASR_PROVIDER_NAMES` / `TRANSLATION_PROVIDER_NAMES`, a `<Vendor>Config` type, defaults for endpoint/model. |
| 2 | `config.ts` | Read `ECHOFLOW_*`/vendor env vars into that config. Drop the whole credential object when a required var is missing — that is what health reporting keys on. |
| 3 | `configHealth.ts` | Name the credential vars so boot fails fast with the exact missing variables and `/v1/capabilities` reports `*_credentials_missing`. Remove the name from the unimplemented set if it was reserved. |
| 4 | `providers/providerFactory.ts` | Construct the adapter. |
| 5 | `.env.example`, `README.md` | Document the variables. |

If the vendor's target-language list differs from `PIPELINE_TARGET_LANGUAGES`
(`realtime/capabilities.ts`), make that list provider-dependent rather than
widening it: the extension only offers what capabilities advertise.

## Building a streaming ASR adapter

Copy the shape of `volcengineSpeechProvider.ts`:

- **Transport seam.** Take a `connect(options, callbacks)` factory as a
  constructor argument with the real WebSocket as the default. Unit tests pass a
  fake transport and never touch the network or need credentials.
- **Reconnect.** Wrap the transport with `withReconnect` from
  `reconnectingTransport.ts`. Classify vendor errors as retryable vs fatal, and
  re-send the session-init frame in `initialize`. Audio during the gap is
  dropped by design; report `onStatus` so the overlay shows 重连中….
- **Reconcile vendor results into finals.** Vendors re-send growing or
  re-punctuated text; write a small pure reconciler (`utteranceReconciler.ts`
  is the model) that dedupes by utterance boundary, not by text, and test it in
  isolation.
- **Resampling.** If the vendor needs a rate other than 16 kHz, resample in the
  adapter. The canonical format is fixed; the extension does not change per
  vendor.
- **Lifecycle guards.** `ending` / `closed` / `disposed` flags exactly as in the
  Volcengine adapter; there are eight adapter tests in the repo that pin this
  behaviour — mirror them.

## Building a translation adapter

Copy `volcengineTranslationProvider.ts`: inject `fetch` (`FetchLike`), return
`""` for blank input, throw on non-2xx and on a malformed body, map language
codes locally. Tests stub `fetch` and assert the request body and the error
paths.

## Tests that must exist

- Adapter unit tests with the transport / fetch seam (no network).
- Reconciler tests with a captured sample of real vendor frames, checked in
  under the test file, so future maintainers can see what the vendor actually
  sends.
- `configHealth.test.ts` and `providerFactory.test.ts` cases for the new name:
  missing credentials → fail-fast message naming the variables.

CI runs the fake providers only. Before opening the PR, run one real session
against the vendor and note in the PR what you saw: first-final latency,
whether reconnect worked when you pulled the network, and the last line
surviving Stop.

## What a PR looks like

`feat(backend): <vendor> streaming ASR adapter` — one adapter per PR,
spec-first if the vendor protocol is non-trivial (see
`docs/superpowers/specs/2026-06-16-volcengine-asr-design.md` for the level of
detail that has paid off). Include the env variables in `.env.example`, a README
paragraph, and the real-session notes above.
