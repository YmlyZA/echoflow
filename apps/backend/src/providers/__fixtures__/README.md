# OpenAI Realtime transcription fixture

`openai-realtime-events.jsonl` is a real session captured with
`apps/backend/scripts/openai-realtime-probe.ts` (Task 0 of the OpenAI provider
plan). One JSON object per line: `{ t, pushedMs, dir, event }` — `t` is ms
since the socket opened, `pushedMs` the audio pushed so far, `dir` whether we
sent or received it. `session.created`/`session.updated` bodies are reduced to
the audio-input config.

The protocol codec and reconciler tests replay this file. Answers below come
from the probe's summary and decide the adapter's behaviour — fill them in
when the capture is committed.

| | Question | Answer |
|---|---|---|
| a | Do `speech_started` / `speech_stopped` carry `audio_start_ms` / `audio_end_ms`? | _pending_ |
| b | Do transcript deltas arrive before `speech_stopped`? | _pending_ |
| c | Exact `…transcription.failed` shape (or "none observed")? | _pending_ |
| d | Is a detected language reported anywhere? | _pending_ |
| e | Which `audio.input.format` shape did the server accept? | _pending_ |
| f | First-final latency after the first append? | _pending_ |

Capture details: model, date, input duration, base URL host — _pending_.
