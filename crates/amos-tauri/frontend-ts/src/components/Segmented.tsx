export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}

export default function Segmented<T extends string>({ value, options, onChange, ariaLabel }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg bg-neutral-200 p-0.5 dark:bg-neutral-800"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={
              "rounded-md px-3 py-1 text-sm transition " +
              (active
                ? "bg-white text-neutral-900 shadow dark:bg-neutral-950 dark:text-white"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
