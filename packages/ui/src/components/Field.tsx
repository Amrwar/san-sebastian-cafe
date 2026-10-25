import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
} from "react";
import { cn } from "../cn";

const control =
  "block w-full min-h-11 rounded-sm border border-line-strong bg-ivory-raised px-3.5 py-2.5 " +
  "text-base text-espresso placeholder:text-espresso-muted/70 " +
  "transition-colors hover:border-espresso-muted focus-visible:border-burgundy " +
  "aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-60";

interface FieldOwnProps {
  label: ReactNode;
  /** Help text linked to the control with aria-describedby. */
  hint?: ReactNode;
  /** Validation message; sets aria-invalid and is linked with aria-describedby. */
  error?: ReactNode;
  /** Optional-field marker shown after the label. */
  optionalLabel?: ReactNode;
  className?: string;
}

interface FieldIds {
  inputId: string;
  hintId: string;
  errorId: string;
}

function useFieldIds(id?: string): FieldIds {
  const generated = useId();
  const base = id ?? generated;
  return { inputId: base, hintId: base + "-hint", errorId: base + "-error" };
}

function describedBy(hint: unknown, error: unknown, ids: FieldIds): string | undefined {
  const parts = [hint ? ids.hintId : null, error ? ids.errorId : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function FieldFrame({
  ids,
  label,
  hint,
  error,
  optionalLabel,
  className,
  children,
}: FieldOwnProps & { ids: FieldIds; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={ids.inputId} className="text-sm font-semibold text-espresso">
        {label}
        {optionalLabel ? (
          <span className="ms-1.5 font-normal text-espresso-muted">{optionalLabel}</span>
        ) : null}
      </label>
      {hint ? (
        <p id={ids.hintId} className="text-sm text-espresso-muted">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={ids.errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = FieldOwnProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className">;

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, optionalLabel, className, id, ...input },
  ref,
) {
  const ids = useFieldIds(id);
  return (
    <FieldFrame
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      optionalLabel={optionalLabel}
      className={className}
    >
      <input
        ref={ref}
        id={ids.inputId}
        className={control}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
        {...input}
      />
    </FieldFrame>
  );
});

export type TextAreaFieldProps = FieldOwnProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;

/** Multi-line text, with the same label, hint and error wiring as TextField. */
export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField(
    { label, hint, error, optionalLabel, className, id, rows = 4, ...input },
    ref,
  ) {
    const ids = useFieldIds(id);
    return (
      <FieldFrame
        ids={ids}
        label={label}
        hint={hint}
        error={error}
        optionalLabel={optionalLabel}
        className={className}
      >
        <textarea
          ref={ref}
          id={ids.inputId}
          rows={rows}
          className={cn(control, "resize-y")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint, error, ids)}
          {...input}
        />
      </FieldFrame>
    );
  },
);

export type SelectFieldProps = FieldOwnProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & { children: ReactNode };

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, optionalLabel, className, id, children, ...select },
  ref,
) {
  const ids = useFieldIds(id);
  return (
    <FieldFrame
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      optionalLabel={optionalLabel}
      className={className}
    >
      <select
        ref={ref}
        id={ids.inputId}
        className={cn(control, "pe-8")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
        {...select}
      >
        {children}
      </select>
    </FieldFrame>
  );
});

export interface CheckboxFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
}

export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(
  function CheckboxField({ label, hint, className, id, ...input }, ref) {
    const ids = useFieldIds(id);
    return (
      <div className={cn("flex items-start gap-3", className)}>
        <input
          ref={ref}
          id={ids.inputId}
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-burgundy"
          aria-describedby={hint ? ids.hintId : undefined}
          {...input}
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={ids.inputId} className="text-[0.95rem] font-medium text-espresso">
            {label}
          </label>
          {hint ? (
            <p id={ids.hintId} className="text-sm text-espresso-muted">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
);
