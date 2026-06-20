// All numeric values are pinned by docs/superpowers/references/2026-06-20-ast-wire-reference.md.

export const DEFAULT_VOLCENGINE_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
export const DEFAULT_VOLCENGINE_AST_RESOURCE_ID = "volc.service_type.10053";

// 4-byte header nibbles (bigmodel event-protocol family).
export const AST_PROTOCOL_VERSION = 0b0001; // 0x1
export const AST_HEADER_SIZE = 0b0001; // 0x1 → ×4 = 4 bytes
export const AST_FLAGS_WITH_EVENT = 0b0100; // used on every frame (byte 1 low nibble)

// Message type nibbles (high nibble of byte 1).
export const AST_MSG_TYPE_FULL_CLIENT = 0b0001;
export const AST_MSG_TYPE_AUDIO_ONLY = 0b0010;
export const AST_MSG_TYPE_FULL_SERVER = 0b1001;
export const AST_MSG_TYPE_ERROR = 0b1111;

// Serialization nibbles (high nibble of byte 2).
export const AST_SERIALIZATION_NONE = 0b0000; // RAW (audio frames)
export const AST_SERIALIZATION_PROTOBUF = 0b0010; // PROTOBUF (control/server frames)

// Compression nibble (low nibble of byte 2). AST uses NONE.
export const AST_COMPRESSION_NONE = 0b0000;

// Outbound event ids (client→server) — events.proto Type enum.
export const AST_EVENT_START_SESSION = 100;
export const AST_EVENT_FINISH_SESSION = 102;
export const AST_EVENT_TASK_REQUEST = 200;

// Inbound event ids (server→client) — events.proto Type enum.
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

// TranslateRequest (ast_service.proto) — outbound payload fields.
export const AST_REQ_FIELD_EVENT = 2; // varint: mirror of frame event id
export const AST_REQ_FIELD_SOURCE_AUDIO = 4; // len-delim: Audio message
export const AST_REQ_FIELD_REQUEST = 6; // len-delim: ReqParams message

// ReqParams sub-message fields (ast_service.proto).
export const AST_REQPARAMS_FIELD_MODE = 1; // string: "s2t"
export const AST_REQPARAMS_FIELD_SOURCE_LANGUAGE = 2; // string: "" = auto-detect
export const AST_REQPARAMS_FIELD_TARGET_LANGUAGE = 3; // string: "zh" | "en"

// Audio sub-message fields (au_base.proto — understanding.Audio).
export const AST_AUDIO_FIELD_FORMAT = 4; // string: "pcm"
export const AST_AUDIO_FIELD_RATE = 7; // int32: 16000
export const AST_AUDIO_FIELD_BITS = 8; // int32: 16
export const AST_AUDIO_FIELD_CHANNEL = 9; // int32: 1

// TranslateResponse (ast_service.proto) — inbound payload fields.
export const AST_RESP_FIELD_RESPONSE_META = 1; // len-delim: ResponseMeta (for error details)
export const AST_RESP_FIELD_TEXT = 4; // string: subtitle text (source OR translation)
export const AST_RESP_FIELD_START_TIME = 5; // int32 (varint): utterance start ms
export const AST_RESP_FIELD_END_TIME = 6; // int32 (varint): utterance end ms

// ResponseMeta sub-message fields (rpcmeta.proto — common.ResponseMeta).
export const AST_META_FIELD_STATUS_CODE = 3; // int32: error code on SessionFailed
export const AST_META_FIELD_MESSAGE = 4; // string: error message on SessionFailed
