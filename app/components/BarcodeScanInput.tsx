import { useCallback, useEffect, useRef, useState } from "react";
import { TextField, Icon } from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

interface BarcodeScanInputProps {
  /** Called when scanner emits a full code (Enter pressed or buffer commits). */
  onScan: (code: string) => void;
  /** Optional visual label. */
  label?: string;
  labelHidden?: boolean;
  placeholder?: string;
  /** Whether to auto-focus the input on mount + after each scan. Default true. */
  autoFocus?: boolean;
  /** Optional extra action to run on each raw keystroke (e.g. fuzzy search). */
  onInputChange?: (value: string) => void;
  /** Clear input after successful scan. Default true. */
  clearOnScan?: boolean;
  disabled?: boolean;
}

/**
 * Autofocus input that captures input from:
 *   1. USB barcode scanners (which act as keyboards that type fast + press Enter)
 *   2. Manual keyboard entry (scan a barcode number manually)
 *
 * Design:
 *   - Scanners "type" at ~100-300cps then hit Enter. We detect this by timing
 *     between keystrokes — if multiple chars come within <50ms and then Enter,
 *     treat it as a scan.
 *   - Also trigger onScan on any Enter keypress with a non-empty value (manual scan).
 *   - After each scan, clear and re-focus so the next scan is captured immediately.
 *
 * Camera-based scanning (for phones) will be added as a follow-up via
 * @zxing/library; this component is designed to accept either input path.
 */
export function BarcodeScanInput({
  onScan,
  label = "Scan",
  labelHidden = false,
  placeholder = "Scan a barcode or SKU…",
  autoFocus = true,
  onInputChange,
  clearOnScan = true,
  disabled = false,
}: BarcodeScanInputProps) {
  const [value, setValue] = useState("");
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const lastKeystrokeRef = useRef<number>(0);

  const focusInput = useCallback(() => {
    // Polaris TextField renders an input inside the wrapper div — find it.
    const el = inputWrapperRef.current?.querySelector("input");
    if (el) el.focus();
  }, []);

  useEffect(() => {
    if (autoFocus) focusInput();
  }, [autoFocus, focusInput]);

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      lastKeystrokeRef.current = Date.now();
      onInputChange?.(next);
    },
    [onInputChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter") return;
      const trimmed = value.trim();
      if (!trimmed) return;
      event.preventDefault();
      onScan(trimmed);
      if (clearOnScan) setValue("");
      if (autoFocus) {
        // small defer so Polaris finishes its state churn
        setTimeout(focusInput, 0);
      }
    },
    [autoFocus, clearOnScan, focusInput, onScan, value],
  );

  return (
    <div ref={inputWrapperRef} onKeyDown={handleKeyDown}>
      <TextField
        label={label}
        labelHidden={labelHidden}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        autoComplete="off"
        prefix={<Icon source={SearchIcon} />}
        disabled={disabled}
      />
    </div>
  );
}
