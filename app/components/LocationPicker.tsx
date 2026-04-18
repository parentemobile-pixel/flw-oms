import { useCallback, useEffect } from "react";
import { Select } from "@shopify/polaris";

export interface LocationOption {
  id: string;
  name: string;
}

interface LocationPickerProps {
  locations: LocationOption[];
  value: string | null;
  onChange: (locationId: string) => void;
  label?: string;
  labelHidden?: boolean;
  /** localStorage key prefix for persisting last-used location */
  persistKey?: string;
  /** Disable picker (e.g. while saving) */
  disabled?: boolean;
}

/**
 * Dropdown of Shopify locations. Remembers the last-selected location per
 * context (via `persistKey`) so a user returning to a page defaults to what
 * they were working on last time.
 */
export function LocationPicker({
  locations,
  value,
  onChange,
  label = "Location",
  labelHidden = false,
  persistKey,
  disabled = false,
}: LocationPickerProps) {
  // On mount: if no value set yet, try to restore last-used from localStorage,
  // otherwise default to the first location.
  useEffect(() => {
    if (value) return;
    if (locations.length === 0) return;

    let restored: string | null = null;
    if (persistKey && typeof window !== "undefined") {
      restored = window.localStorage.getItem(`flw-oms.location.${persistKey}`);
    }

    const valid = restored && locations.some((l) => l.id === restored);
    const target = valid ? (restored as string) : locations[0].id;
    onChange(target);
    // Intentionally only want this on first render + whenever locations load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations]);

  const handleChange = useCallback(
    (next: string) => {
      if (persistKey && typeof window !== "undefined") {
        window.localStorage.setItem(`flw-oms.location.${persistKey}`, next);
      }
      onChange(next);
    },
    [onChange, persistKey],
  );

  const options = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <Select
      label={label}
      labelHidden={labelHidden}
      options={options}
      value={value ?? ""}
      onChange={handleChange}
      disabled={disabled || locations.length === 0}
    />
  );
}
