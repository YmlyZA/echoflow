// Opt-in manual smoke for the real Volcengine AST (豆包同声传译 / interpret mode).
//
// Usage (from repo root):
//   VOLCENGINE_AST_API_KEY=... \
//   pnpm --filter @echoflow/backend exec tsx ../../scripts/volcengine-ast-smoke.ts path/to/audio.pcm [targetLang] [sourceLang]
//
// The audio file must be raw 16 kHz / 16-bit / mono little-endian PCM (or a WAV
// with that format — its 44-byte header is skipped). targetLang defaults to zh-CN,
// sourceLang defaults to en.
//
// This harness instruments the transport to print EVERY raw decoded AST event
// (kind/text/final/timestamps) alongside the reconciled ServerEvents, so the 7
// `[confirm @ e2e]` items in docs/.../2026-06-20-ast-wire-reference.md §6 can be
// checked against reality — above all whether subtitle `text` is cumulative
// (each frame repeats the full line) or delta (each frame appends). Never runs
// in CI (no Vitest, needs creds).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseAstMessage } from "../apps/backend/src/providers/astProtocol.js";
import {
  connectAstTransport,
  type AstTransportFactory,
} from "../apps/backend/src/providers/astTransport.js";
import {
  DEFAULT_VOLCENGINE_AST_ENDPOINT,
  DEFAULT_VOLCENGINE_AST_RESOURCE_ID,
} from "../apps/backend/src/providers/providerConfig.js";
import { InterpretationSubtitleSource } from "../apps/backend/src/realtime/interpretationSubtitleSource.js";

const audioPath = process.argv[2];
const targetLanguage = process.argv[3] ?? "zh-CN";
const sourceLanguage = process.argv[4] ?? "en";
if (audioPath === undefined) {
  console.error(
    "usage: tsx scripts/volcengine-ast-smoke.ts <audio.pcm|audio.wav> [targetLang] [sourceLang]",
  );
  process.exit(1);
}

const apiKey = requireEnv("VOLCENGINE_AST_API_KEY");

const raw = readFileSync(audioPath);
// Skip a 44-byte WAV header if present.
const pcm = raw.subarray(0, 4).toString("ascii") === "RIFF" ? raw.subarray(44) : raw;

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

// Wrap the real transport so every inbound frame is decoded and logged raw,
// then handed unchanged to the source's own onMessage. This shows the wire
// truth (cumulative vs delta, segment-start/response/end boundaries) without
// altering production behavior.
const instrumentedConnect: AstTransportFactory = (options, callbacks) =>
  connectAstTransport(options, {
    ...callbacks,
    onMessage: (data) => {
      // Dump the raw envelope first so a parser mismatch is diagnosable.
      const head = data.subarray(0, Math.min(data.length, 64)).toString("hex");
      console.log(`[bytes ${stamp()}] len=${data.length} head=${head}`);
      try {
        const ev = parseAstMessage(data);
        console.log(`[wire ${stamp()}] ${JSON.stringify(ev)}`);
        callbacks.onMessage(data);
      } catch (err) {
        console.log(`[parse-error ${stamp()}] ${(err as Error).message}`);
      }
    },
  });

const source = new InterpretationSubtitleSource(
  {
    apiKey,
    resourceId:
      process.env.VOLCENGINE_AST_RESOURCE_ID ?? DEFAULT_VOLCENGINE_AST_RESOURCE_ID,
    endpoint: process.env.VOLCENGINE_AST_ENDPOINT ?? DEFAULT_VOLCENGINE_AST_ENDPOINT,
  },
  sourceLanguage,
  targetLanguage,
  instrumentedConnect,
);

await new Promise<void>((resolve, reject) => {
  let finals = 0;
  const stream = source.open({
    onEvent: (e) => {
      if (e.type === "language") {
        console.log(`[language ${stamp()}] ${e.sourceLanguage} -> ${e.targetLanguage}`);
      } else if (e.type === "partial") {
        console.log(`[partial ${stamp()}:${e.segmentId}] ${e.sourceText}`);
      } else if (e.type === "final") {
        finals += 1;
        console.log(
          `[final ${stamp()}:${e.segmentId}] src="${e.sourceText}" -> "${e.translatedText}" [${e.startTimeMs}..${e.endTimeMs}ms]`,
        );
      } else if (e.type === "error") {
        console.log(`[error ${stamp()}] ${e.code}: ${e.message}`);
      }
    },
    onError: (error) => reject(error),
  });

  void (async () => {
    // ~100 ms frames, paced in real time so server-side VAD segments naturally
    // and the latency reads reflect a live session.
    const frameBytes = 3200; // 16000 samples/s * 2 bytes * 0.1 s
    let sequence = 0;
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      stream.pushFrame({
        data: pcm.subarray(offset, offset + frameBytes),
        sequenceNumber: sequence,
        timestampMs: sequence * 100,
      });
      sequence += 1;
      await sleep(100);
    }
    console.log(`[audio ${stamp()}] sent ${sequence} frames, finishing session`);
    await stream.end();
    // Allow trailing finals to arrive before exiting.
    await sleep(3000);
    console.log(`done: ${finals} final segment(s)`);
    await stream.close();
    resolve();
  })().catch(reject);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
