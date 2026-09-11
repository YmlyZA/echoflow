// All blocker wording lives here: the backend emits codes only. Copy must avoid
// apostrophes — renderToStaticMarkup escapes them and component tests break.
const BLOCKER_COPY: Record<string, string> = {
  asr_credentials_missing:
    "Speech recognition is not configured. Set VOLCENGINE_ASR_APP_KEY and VOLCENGINE_ASR_ACCESS_KEY in the backend environment.",
  translation_credentials_missing:
    "Translation is not configured. Set VOLCENGINE_API_KEY in the backend environment.",
  interpret_credentials_missing:
    "Interpret mode is not configured. Set VOLCENGINE_AST_API_KEY in the backend environment.",
  asr_provider_unimplemented:
    "The selected speech recognition provider is not implemented yet. Use fake or volcengine.",
  translation_provider_unimplemented:
    "The selected translation provider is not implemented yet. Use fake or volcengine.",
};

export function describeBlocker(code: string): string {
  return (
    BLOCKER_COPY[code] ??
    `The backend reported a limitation this version does not recognize: ${code}`
  );
}
