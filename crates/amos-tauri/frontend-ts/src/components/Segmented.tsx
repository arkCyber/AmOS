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
      className="inline-flex rounded-[9px] bg-neutral-200/70 p-[3px] ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
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
              "rounded-md px-3.5 py-1.5 text-sm leading-none transition " +
              (active
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-white dark:shadow-black/40"
                : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
