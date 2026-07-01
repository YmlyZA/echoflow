// Shared CSS for the reusable form controls (SegmentedControl, LanguagePicker)
// and the source→target language row. These components ship class names but no
// CSS, so every light surface that uses them (options, popup, onboarding) must
// include this block in its own <style>. Colors use the --ef-* theme tokens.
export const CONTROL_STYLES = `
.ef-seg { display: flex; background: #eef0f2; border-radius: 9px; padding: 3px; gap: 3px; }
.ef-seg-btn { flex: 1; border: 0; background: transparent; border-radius: 7px; padding: 8px 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--ef-text-muted); cursor: pointer; }
.ef-seg-on { background: var(--ef-surface); color: var(--ef-text); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.ef-seg-btn:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 1px; }

.ef-langrow { display: flex; align-items: center; gap: 10px; }
.ef-arrow { color: var(--ef-accent); font-size: 16px; font-weight: 700; }
.ef-picker-static { flex: 1; padding: 10px 12px; border: 1px dashed var(--ef-border); border-radius: 9px; font-size: 12.5px; font-weight: 600; color: var(--ef-text-muted); text-align: center; }

.ef-picker { position: relative; flex: 1; }
.ef-picker-trigger { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border: 1px solid var(--ef-border); border-radius: 9px; background: var(--ef-surface); font: inherit; font-size: 12.5px; font-weight: 600; color: var(--ef-text); cursor: pointer; }
.ef-picker-trigger:hover:not(:disabled) { border-color: #cfd4da; }
.ef-picker-trigger:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 1px; }
.ef-picker-trigger:disabled { opacity: 0.6; cursor: default; }
.ef-picker-code { color: var(--ef-text-muted); font-weight: 600; font-size: 11px; white-space: nowrap; }
.ef-picker-panel { position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; right: 0; background: var(--ef-surface); border: 1px solid var(--ef-border); border-radius: 11px; box-shadow: 0 14px 36px rgba(20,30,40,0.16); overflow: hidden; }
.ef-picker-search { width: 100%; border: 0; border-bottom: 1px solid var(--ef-border); padding: 10px 12px; font: inherit; font-size: 12.5px; color: var(--ef-text); outline: none; }
.ef-picker-list { max-height: 230px; overflow-y: auto; padding: 4px; }
.ef-opt { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--ef-text); cursor: pointer; text-align: left; }
.ef-opt:hover { background: #f4f6f7; }
.ef-opt-sel { background: var(--ef-accent-weak); color: #0d6a5f; }
.ef-opt-code { color: var(--ef-text-muted); font-weight: 600; font-size: 11px; }
.ef-picker-empty { margin: 0; padding: 12px; font-size: 12.5px; color: var(--ef-text-muted); text-align: center; }
`;
