// Task 0 of docs/superpowers/plans/2026-09-12-openai-compatible-provider.md.
//
// Streams a WAV file to the OpenAI Realtime transcription API at real-time pace
// and records every server event as JSONL, so the adapter's protocol codec and
// reconciler tests are written against what the server actually sends rather
// than against the docs. Throwaway: not typechecked, not built, not shipped.
//
//   OPENAI_API_KEY=sk-... pnpm --filter @echoflow/backend probe:openai <in.wav> <out.jsonl>
//
// Optional: OPENAI_ASR_BASE_URL (default https://api.openai.com/v1),
//           OPENAI_ASR_MODEL (default gpt-live-transcribe),
//           OPENAI_ASR_SILENCE_MS (default 600).
//
// Input: 16-bit PCM mono WAV at any rate (16 kHz preferred — that is the
// extension's canonical format). Resampled to 24 kHz inline with naive linear
// interpolation; the tested resampler lands in Task 3.

import { readFileSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";

const [wavPath, outPath] = process.argv.slice(2);
if (!wavPath || !outPath) {
  console.error("usage: probe <in.wav> <out.jsonl>");
  process.exit(2);
}
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}
const baseUrl = (process.env.OPENAI_ASR_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const model = process.env.OPENAI_ASR_MODEL ?? "gpt-live-transcribe";
const silenceMs = Number(process.env.OPENAI_ASR_SILENCE_MS ?? 600);
const TARGET_RATE = 24000;
const FRAME_MS = 100;

// ---- WAV ------------------------------------------------------------------

function readWav(path: string): { rate: number; samples: Int16Array } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format !== 1) throw new Error(`unsupported WAV format tag ${format} (need PCM)`);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");
  if (channels !== 1 || bits !== 16) throw new Error(`need 16-bit mono, got ${bits}-bit ${channels}ch`);
  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2);
  return { rate, samples };
}

function resampleLinear(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return input;
  const outLen = Math.floor((input.length * to) / from);
  const out = new Int16Array(outLen);
  const step = from / to;
  for (let i = 0; i < outLen; i += 1) {
    const p = i * step;
    const j = Math.floor(p);
    const a = input[j] ?? 0;
    const b = input[Math.min(j + 1, input.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * (p - j));
  }
  return out;
}

// ---- Session --------------------------------------------------------------

type Line = { t: number; pushedMs: number; dir: "server" | "client"; event: unknown };
const lines: Line[] = [];
const started = Date.now();
let pushedMs = 0;
let firstAppendAt: number | undefined;
const now = (): number => Date.now() - started;

function log(dir: Line["dir"], event: unknown): void {
  lines.push({ t: now(), pushedMs, dir, event: scrub(event) });
}

// session.created/updated echo the whole session config, which can include
// account-level fields. Keep only what the adapter needs to know about.
function scrub(event: unknown): unknown {
  const e = event as { type?: string; session?: Record<string, unknown> };
  if ((e.type === "session.created" || e.type === "session.updated") && e.session) {
    const audio = e.session.audio as { input?: Record<string, unknown> } | undefined;
    return {
      type: e.type,
      session: {
        type: e.session.type,
        audio: { input: { format: audio?.input?.format, turn_detection: audio?.input?.turn_detection, transcription: audio?.input?.transcription } },
      },
    };
  }
  return event;
}

function sessionUpdate(format: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format,
          transcription: { model },
          turn_detection: { type: "server_vad", silence_duration_ms: silenceMs },
        },
      },
    },
  };
}

const FORMAT_ATTEMPTS: Record<string, unknown>[] = [
  { type: "audio/pcm", rate: TARGET_RATE },
  { type: "audio/pcm" },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const wav = readWav(wavPath);
  const pcm = resampleLinear(wav.samples, wav.rate, TARGET_RATE);
  const frameSamples = (TARGET_RATE * FRAME_MS) / 1000;
  console.error(`wav: ${wav.rate} Hz, ${(wav.samples.length / wav.rate).toFixed(1)} s → ${pcm.length} samples @ ${TARGET_RATE}`);

  const url = `${baseUrl.replace(/^http/, "ws")}/realtime?intent=transcription`;
  console.error(`connecting ${url} model=${model}`);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });

  let formatAttempt = 0;
  let sessionReady = false;
  const send = (obj: Record<string, unknown>): void => {
    if (obj.type !== "input_audio_buffer.append") log("client", obj);
    ws.send(JSON.stringify(obj));
  };

  const closed = new Promise<void>((resolve) => ws.on("close", (code, reason) => {
    log("server", { type: "_socket.close", code, reason: reason.toString() });
    resolve();
  }));
  ws.on("error", (error) => log("server", { type: "_socket.error", message: error.message }));
  ws.on("message", (raw) => {
    let event: { type?: string; error?: { message?: string } };
    try { event = JSON.parse(raw.toString()); } catch { log("server", { type: "_unparseable", raw: raw.toString().slice(0, 200) }); return; }
    log("server", event);
    if (event.type === "session.updated") sessionReady = true;
    if (event.type === "error" && !sessionReady && formatAttempt < FORMAT_ATTEMPTS.length - 1) {
      formatAttempt += 1;
      console.error(`session.update rejected (${event.error?.message}); retrying with format ${JSON.stringify(FORMAT_ATTEMPTS[formatAttempt])}`);
      send(sessionUpdate(FORMAT_ATTEMPTS[formatAttempt]!));
    }
  });

  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  send(sessionUpdate(FORMAT_ATTEMPTS[0]!));
  for (let i = 0; i < 30 && !sessionReady; i += 1) await sleep(100);
  if (!sessionReady) console.error("warning: no session.updated within 3 s, streaming anyway");

  for (let offset = 0; offset < pcm.length; offset += frameSamples) {
    const frame = pcm.subarray(offset, offset + frameSamples);
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.length * 2);
    firstAppendAt ??= now();
    send({ type: "input_audio_buffer.append", audio: bytes.toString("base64") });
    pushedMs += (frame.length * 1000) / TARGET_RATE;
    await sleep(FRAME_MS);
  }
  send({ type: "input_audio_buffer.commit" });
  await sleep(5000);
  ws.close();
  await Promise.race([closed, sleep(2000)]);

  writeFileSync(outPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  summarize();
}

// ---- Summary: the spec's unverified items, answered from the log ----------

function summarize(): void {
  const server = lines.filter((l) => l.dir === "server").map((l) => ({ ...l, event: l.event as Record<string, unknown> }));
  const counts = new Map<string, number>();
  for (const l of server) counts.set(String(l.event.type), (counts.get(String(l.event.type)) ?? 0) + 1);
  console.error("\nevent counts:");
  for (const [type, n] of [...counts].sort()) console.error(`  ${n.toString().padStart(4)}  ${type}`);

  const find = (type: string) => server.filter((l) => l.event.type === type);
  const startedEv = find("input_audio_buffer.speech_started")[0]?.event;
  const stoppedEv = find("input_audio_buffer.speech_stopped")[0]?.event;
  const deltas = find("conversation.item.input_audio_transcription.delta");
  const completed = find("conversation.item.input_audio_transcription.completed");
  const failed = find("conversation.item.input_audio_transcription.failed");
  const firstStop = find("input_audio_buffer.speech_stopped")[0];

  console.error("\nanswers for __fixtures__/README.md:");
  console.error(`  (a) speech_started keys: ${startedEv ? Object.keys(startedEv).join(", ") : "none seen"}`);
  console.error(`      speech_stopped keys: ${stoppedEv ? Object.keys(stoppedEv).join(", ") : "none seen"}`);
  console.error(`  (b) deltas before first speech_stopped: ${firstStop ? deltas.filter((d) => d.t < firstStop.t).length : "n/a"} of ${deltas.length}`);
  console.error(`  (c) failed events: ${failed.length}${failed[0] ? " e.g. " + JSON.stringify(failed[0].event) : ""}`);
  const langKeys = server.filter((l) => JSON.stringify(l.event).includes("language")).map((l) => l.event.type);
  console.error(`  (d) events mentioning "language": ${langKeys.length ? [...new Set(langKeys)].join(", ") : "none"}`);
  const accepted = lines.filter((l) => l.dir === "client" && (l.event as { type?: string }).type === "session.update").at(-1)?.event as { session?: { audio?: { input?: { format?: unknown } } } } | undefined;
  console.error(`  (e) accepted format: ${JSON.stringify(accepted?.session?.audio?.input?.format)}`);
  const first = completed[0];
  console.error(`  (f) first final: ${first ? `${first.t - (firstAppendAt ?? 0)} ms after first append (pushedMs=${first.pushedMs}), ${JSON.stringify((first.event as { transcript?: string }).transcript)}` : "none"}`);
  console.error(`\nwrote ${lines.length} lines to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
