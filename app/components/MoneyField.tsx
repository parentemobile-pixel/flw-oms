import { useEffect, useRef, useState } from "react";
import { TextField } from "@shopify/polaris";

/**
 * Number input that preserves trailing decimal zeros while typing.
 *
 * The naive `value={String(numericValue)}` + `onChange={parseFloat(v)||0}`
 * pattern silently drops user input mid-type. Type "12.0" and parseFloat
 * normalizes to 12, the next render writes back "12", and the trailing
 * zero (or the bare ".") disappears under the user's cursor. Same problem
 * for "12.05" if you type the "0" first.
 *
 * Fix: keep a string buffer of what the user actually typed; only emit
 * a numeric value to the parent when the buffer parses cleanly. Sync
 * the buffer back from the parent only when the parent's number genuinely
 * differs from what we last emitted (defends against external resets,
 * e.g. picking a different variant in the same row).
 */
export interface MoneyFieldProps {
  label: string;
  labelHidden?: boolean;
  value: number;
  onChange: (next: number) => void;
  prefix?: string;
  placeholder?: string;
  disabled?: boolean;
  min?: number;
}

export function MoneyField({
  label,
  labelHidden = true,
  value,
  onChange,
  prefix = "$",
  placeholder,
  disabled,
  min = 0,
}: MoneyFieldProps) {
  // The buffer holds whatever the user typed (or whatever we initialized
  // from). lastEmittedRef holds the last numeric value WE pushed into the
  // parent — so an external reset (parent sets a new value) is detected
  // by parent !== lastEmitted.
  const [buffer, setBuffer] = useState<string>(() => formatInitial(value));
  const lastEmittedRef = useRef<number>(value);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      setBuffer(formatInitial(value));
      lastEmittedRef.current = value;
    }
  }, [value]);

  return (
    <TextField
      label={label}
      labelHidden={labelHidden}
      value={buffer}
      onChange={(raw) => {
        // Allow the user to clear the field, type a leading decimal,
        // type any partial decimal ("12.", "12.0", "12.05"). We accept
        // any string here and only normalize what we report upward.
        setBuffer(raw);
        if (raw === "" || raw === "." || raw === "-") {
          if (lastEmittedRef.current !== 0) {
            lastEmittedRef.current = 0;
            onChange(0);
          }
          return;
        }
        const parsed = parseFloat(raw);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.max(min, parsed);
        if (clamped !== lastEmittedRef.current) {
          lastEmittedRef.current = clamped;
          onChange(clamped);
        }
      }}
      type="number"
      // Step lets the spinners go in cents; min keeps the value non-
      // negative for cost inputs.
      step={0.01}
      min={min}
      autoComplete="off"
      prefix={prefix}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

function formatInitial(n: number): string {
  // 0 stays "0"; integers as-is; floats keep their natural representation.
  // Avoids surprises like "0.30" turning into "0.3" after a save round-trip
  // — we'll show the raw number; the user can re-type if they want a
  // different precision.
  if (!Number.isFinite(n)) return "0";
  return String(n);
}
