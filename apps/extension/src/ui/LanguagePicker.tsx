import { useEffect, useRef, useState } from "react";
import type { LanguageOption } from "@echoflow/protocol";
import { filterLanguages } from "../settings/languageSelection.js";

export function LanguagePicker({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "Select…",
}: {
  value: string;
  options: LanguageOption[];
  onChange: (code: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocPointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selected = options.find((option) => option.code === value);
  const filtered = filterLanguages(options, query);

  function pick(code: string) {
    onChange(code);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="ef-picker" ref={rootRef}>
      <button
        type="button"
        className="ef-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span className="ef-picker-value">{selected ? selected.label : placeholder}</span>
        <span className="ef-picker-code">
          {selected ? selected.code.toUpperCase() : ""} ▾
        </span>
      </button>

      {open && !disabled ? (
        <div className="ef-picker-panel" role="listbox" aria-label={ariaLabel}>
          <input
            className="ef-picker-search"
            type="text"
            autoFocus
            placeholder="Search language…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="ef-picker-list">
            {filtered.length ? (
              filtered.map((option) => (
                <button
                  key={option.code}
                  type="button"
                  role="option"
                  aria-selected={option.code === value}
                  className={
                    option.code === value ? "ef-opt ef-opt-sel" : "ef-opt"
                  }
                  onClick={() => pick(option.code)}
                >
                  <span>{option.label}</span>
                  <span className="ef-opt-code">{option.code.toUpperCase()}</span>
                </button>
              ))
            ) : (
              <p className="ef-picker-empty">No match</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
