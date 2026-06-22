// All numeric values are pinned by docs/superpowers/references/2026-06-20-ast-wire-reference.md.
//
// AST v2 (/api/v4/ast/v2/translate) is a gRPC ASTService.Translate stream exposed
// over WebSocket: each ws binary message is ONE bare serialized protobuf
// (TranslateRequest up, TranslateResponse down). There is NO binary frame header,
// event-int32, or sessionId-length envelope — the event id and session id are
// protobuf fields. Confirmed against the live server (it unmarshals each ws
// message directly as protobuf).

export const DEFAULT_VOLCENGINE_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
export const DEFAULT_VOLCENGINE_AST_RESOURCE_ID = "volc.service_type.10053";

// Event ids — events.proto Type enum (proto3 enum = varint).
// Outbound (client→server).
export const AST_EVENT_START_SESSION = 100;
export const AST_EVENT_FINISH_SESSION = 102;
export const AST_EVENT_TASK_REQUEST = 200;

// Inbound (server→client).
export const AST_EVENT_SESSION_STARTED = 150;
export const AST_EVENT_SESSION_CANCELED = 151;
export const AST_EVENT_SESSION_FINISHED = 152;
export const AST_EVENT_SESSION_FAILED = 153;
export const AST_EVENT_USAGE = 154;
export const AST_EVENT_SOURCE_START = 650;
export const AST_EVENT_SOURCE_RESPONSE = 651;
export const AST_EVENT_SOURCE_END = 652;
export const AST_EVENT_TRANSLATION_START = 653;
export const AST_EVENT_TRANSLATION_RESPONSE = 654;
export const AST_EVENT_TRANSLATION_END = 655;

// Protobuf field numbers — from vendor .proto files (authoritative per the reference).

// TranslateRequest (ast_service.proto) — outbound message fields.
export const AST_REQ_FIELD_REQUEST_META = 1; // len-delim: RequestMeta message
export const AST_REQ_FIELD_EVENT = 2; // varint: event.Type
export const AST_REQ_FIELD_SOURCE_AUDIO = 4; // len-delim: Audio message
export const AST_REQ_FIELD_REQUEST = 6; // len-delim: ReqParams message

// RequestMeta sub-message fields (rpcmeta.proto — common.RequestMeta).
export const AST_REQMETA_FIELD_RESOURCE_ID = 4; // string: volc.service_type.10053
export const AST_REQMETA_FIELD_SESSION_ID = 6; // string: per-session UUID (required for WS)

// ReqParams sub-message fields (ast_service.proto — ast.ReqParams).
export const AST_REQPARAMS_FIELD_MODE = 1; // string: "s2t" (speech→text subtitles)
export const AST_REQPARAMS_FIELD_SOURCE_LANGUAGE = 2; // string: "" = auto-detect
export const AST_REQPARAMS_FIELD_TARGET_LANGUAGE = 3; // string: "zh" | "en"

// Audio sub-message fields (au_base.proto — understanding.Audio).
export const AST_AUDIO_FIELD_FORMAT = 4; // string: "pcm"
export const AST_AUDIO_FIELD_RATE = 7; // int32: 16000
export const AST_AUDIO_FIELD_BITS = 8; // int32: 16
export const AST_AUDIO_FIELD_CHANNEL = 9; // int32: 1
export const AST_AUDIO_FIELD_BINARY_DATA = 14; // bytes: raw PCM chunk

// TranslateResponse (ast_service.proto) — inbound message fields.
export const AST_RESP_FIELD_RESPONSE_META = 1; // len-delim: ResponseMeta (status/error)
export const AST_RESP_FIELD_EVENT = 2; // varint: event.Type
export const AST_RESP_FIELD_TEXT = 4; // string: subtitle text (source OR translation)
export const AST_RESP_FIELD_START_TIME = 5; // int32 (varint): utterance start ms
export const AST_RESP_FIELD_END_TIME = 6; // int32 (varint): utterance end ms

// ResponseMeta sub-message fields (rpcmeta.proto — common.ResponseMeta).
export const AST_META_FIELD_STATUS_CODE = 3; // int32: status/error code
export const AST_META_FIELD_MESSAGE = 4; // string: status/error message

// Status codes. Two layers coexist on this gateway:
//  - 0 = unset (proto3 default).
//  - Gateway codes are 8-digit: 2xxxxxxx = success (observed 20000000 "OK" on
//    SessionStarted/subtitle frames), 4xxxxxxx = client error (observed 45000000
//    "cannot parse payload"), 5xxxxxxx = server error.
//  - Backend service layer (au_base.proto Code) uses 21000 = SUCCESS, 11xxx = errors.
// `isAstOkStatus` treats unset, the backend SUCCESS, and the whole gateway 2x
// success range as non-errors; everything else is surfaced as an error.
export const AST_STATUS_BACKEND_SUCCESS = 21000;
export const AST_STATUS_GATEWAY_OK_MIN = 20000000;
export const AST_STATUS_GATEWAY_OK_MAX = 30000000; // exclusive

export function isAstOkStatus(code: number): boolean {
  return (
    code === 0 ||
    code === AST_STATUS_BACKEND_SUCCESS ||
    (code >= AST_STATUS_GATEWAY_OK_MIN && code < AST_STATUS_GATEWAY_OK_MAX)
  );
}
