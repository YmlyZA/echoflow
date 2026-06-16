// Opt-in manual smoke for the real Volcengine streaming ASR adapter.
//
// Usage (from repo root):
//   VOLCENGINE_ASR_APP_KEY=... VOLCENGINE_ASR_ACCESS_KEY=... \
//   pnpm --filter @echoflow/backend exec tsx ../../scripts/volcengine-asr-smoke.ts path/to/audio.pcm
//
// The audio file must be raw 16 kHz / 16-bit / mono little-endian PCM (or a WAV
// with that format — its 44-byte header is skipped). Prints partial/final
// transcript lines as they arrive. Never runs in CI (no Vitest, needs creds).
import { readFileSync } from "node:fs";
import {
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
} from "../apps/backend/src/providers/providerConfig.js";
import { VolcengineSpeechProvider } from "../apps/backend/src/providers/volcengineSpeechProvider.js";

const audioPath = process.argv[2];
if (audioPath === undefined) {
  console.error("usage: tsx scripts/volcengine-asr-smoke.ts <audio.pcm|audio.wav>");
  process.exit(1);
}

const appKey = requireEnv("VOLCENGINE_ASR_APP_KEY");
const accessKey = requireEnv("VOLCENGINE_ASR_ACCESS_KEY");

const raw = readFileSync(audioPath);
// Skip a 44-byte WAV header if present.
const pcm = raw.subarray(0, 4).toString("ascii") === "RIFF" ? raw.subarray(44) : raw;

const provider = new VolcengineSpeechProvider({
  appKey,
  accessKey,
  resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  endpoint: process.env.VOLCENGINE_ASR_ENDPOINT ?? DEFAULT_VOLCENGINE_ASR_ENDPOINT,
});

await new Promise<void>((resolve, reject) => {
  let finals = 0;
  const stream = provider.open({
    onSegment: (event) => {
      if (event.kind === "language") {
        console.log(`[language] ${event.sourceLanguage}`);
      } else if (event.kind === "partial") {
        console.log(`[partial:${event.segmentId}] ${event.text}`);
      } else {
        finals += 1;
        console.log(`[final:${event.segmentId}] ${event.text}`);
      }
    },
    onError: (error) => reject(error),
  });

  // ~100 ms frames: 16000 samples/s * 2 bytes * 0.1 s = 3200 bytes.
  const frameBytes = 3200;
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    stream.pushFrame({
      data: pcm.subarray(offset, offset + frameBytes),
      sequenceNumber: sequence,
      timestampMs: sequence * 100,
    });
    sequence += 1;
  }

  void stream.end().then(() => {
    // Allow trailing finals to arrive before exiting.
    setTimeout(() => {
      console.log(`done: ${finals} final segment(s)`);
      void stream.close().then(resolve);
    }, 2000);
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
