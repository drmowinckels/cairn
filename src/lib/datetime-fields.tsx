import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  clockPlaceholder,
  datePlaceholder,
  formatClockParts,
  formatNumericDate,
  isoDate,
  parseClock,
  parseNumericDate,
} from "./datetime-format";
import { appLocale } from "./locale";
import { useDateTimeFormat } from "./use-datetime-format";

/**
 * Date and time entry fields that honour the user's format preference (#308).
 *
 * These replace `<input type="time" | "date" | "datetime-local">`. Native
 * pickers render in the *webview's* locale, which WKWebView reports as `en-US`
 * regardless of the machine's region — so they showed a 12-hour clock and a
 * month-first date to everyone, ignoring both the OS locale Cairn already
 * resolves and the preference added in #308. That's not something `Intl` can
 * fix: a native picker's format is not scriptable.
 *
 * Accessibility note on the approach. The alternative was a segmented
 * spinbutton (three `role="spinbutton"` cells, like the native control).
 * A single labelled text field was chosen instead: it is one tab stop rather
 * than three, it works with dictation and paste, and its failure mode is
 * visible text the user can correct. The things a hand-rolled spinbutton
 * usually gets wrong — announcing the segment, wrapping, and the fact that
 * arrow keys do something at all — are exactly the things screen-reader users
 * would then have to discover. What that costs is the native calendar popup,
 * which is the deliberate trade.
 *
 * Every field therefore:
 *  - carries a visible format hint, wired via `aria-describedby`, so the
 *    expected shape is announced with the label rather than only shown in a
 *    placeholder (which screen readers may skip and which vanishes on typing);
 *  - accepts loose input (`1405`, `14.05`, `9:05pm`, `25-12-2026`) and
 *    normalises it on blur, so the field teaches its own format;
 *  - marks unparseable input `aria-invalid` with a real message instead of
 *    silently discarding the keystrokes or guessing a value;
 *  - repaints when the preference changes.
 */

/** Shared props for every field here. */
interface FieldBase {
  /** Accessible name. Required: none of these fields is self-describing. */
  label: string;
  className?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  /** Extra ids to append to `aria-describedby` (e.g. a caller's error text). */
  describedBy?: string;
}

interface TextFieldShellProps extends FieldBase {
  text: string;
  onText: (next: string) => void;
  onCommit: () => void;
  hint: string;
  invalid: boolean;
  invalidMessage: string;
  onStep?: (delta: number) => void;
}

/**
 * The input plus its hint and error text. Factored out so the three fields
 * can't drift apart on the accessibility wiring, which is the part most worth
 * having in exactly one place.
 */
function TextFieldShell({
  label,
  className,
  id,
  required,
  disabled,
  describedBy,
  text,
  onText,
  onCommit,
  hint,
  invalid,
  invalidMessage,
  onStep,
}: TextFieldShellProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errId = `${inputId}-err`;

  const described = [hintId, invalid ? errId : null, describedBy]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        // Native autocorrect on a numeric field turns "1405" into prose on
        // some platforms; there is nothing here worth correcting.
        spellCheck={false}
        className={className}
        value={text}
        aria-label={label}
        aria-describedby={described || undefined}
        aria-invalid={invalid || undefined}
        required={required}
        disabled={disabled}
        placeholder={hint}
        onChange={(e) => onText(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onCommit();
            return;
          }
          if (!onStep) return;
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onStep(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onStep(-1);
          }
        }}
      />
      {/* Screen-reader-only: sighted users get the same string as the
          placeholder while the field is empty, and as part of the visible
          error once it isn't. A permanently visible copy under all eight of
          these fields would be clutter, and `.field-hint` is below the
          12px tertiary floor. */}
      <span id={hintId} className="sr-only">
        {hint}
      </span>
      {invalid && (
        <span id={errId} className="field-error" role="alert">
          {invalidMessage}
        </span>
      )}
    </>
  );
}

/**
 * Keep a draft string in sync with a controlled value, without fighting the
 * user mid-edit: the draft only re-syncs when the incoming value (or the
 * rendering of it) actually changes, never on every keystroke.
 */
function useDraft(rendered: string): [string, (s: string) => void] {
  const [draft, setDraft] = useState(rendered);
  const last = useRef(rendered);
  useEffect(() => {
    if (last.current !== rendered) {
      last.current = rendered;
      setDraft(rendered);
    }
  }, [rendered]);
  return [draft, setDraft];
}

export interface TimeFieldProps extends FieldBase {
  /** Wire value, always `HH:MM` 24-hour. `""` means empty. */
  value: string;
  onChange: (next: string) => void;
}

const HHMM = /^(\d{2}):(\d{2})$/;

function hhmmToMinutes(value: string): number | null {
  const m = HHMM.exec(value);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : null;
}

function minutesToHhmm(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const m = String(wrapped % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * A time-of-day field. The value crossing the boundary is always 24-hour
 * `HH:MM` — the preference changes what's displayed, never what's stored, so
 * switching to a 12-hour clock can't alter a single saved entry.
 */
export function TimeField({ value, onChange, ...base }: TimeFieldProps) {
  const { prefs } = useDateTimeFormat();
  const locale = appLocale();

  const rendered = useMemo(() => {
    const mins = hhmmToMinutes(value);
    if (mins === null) return "";
    return formatClockParts(Math.floor(mins / 60), mins % 60, prefs, locale);
  }, [value, prefs, locale]);

  const [draft, setDraft] = useDraft(rendered);
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    if (!draft.trim()) {
      setInvalid(Boolean(base.required));
      if (!base.required) onChange("");
      return;
    }
    const mins = parseClock(draft, prefs, locale);
    if (mins === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(minutesToHhmm(mins));
  };

  const step = (delta: number) => {
    const mins = parseClock(draft, prefs, locale) ?? hhmmToMinutes(value) ?? 0;
    setInvalid(false);
    onChange(minutesToHhmm(mins + delta));
  };

  return (
    <TextFieldShell
      {...base}
      text={draft}
      onText={(t) => {
        setDraft(t);
        if (invalid) setInvalid(false);
      }}
      onCommit={commit}
      onStep={step}
      hint={clockPlaceholder(prefs, locale)}
      invalid={invalid}
      invalidMessage={`Enter a time like ${clockPlaceholder(prefs, locale)}.`}
    />
  );
}

export interface DateFieldProps extends FieldBase {
  /** Wire value, always `YYYY-MM-DD`. `""` means empty. */
  value: string;
  onChange: (next: string) => void;
}

function isoToDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A calendar-date field. The value crossing the boundary is always
 * `YYYY-MM-DD`, whatever order the user types and reads.
 */
export function DateField({ value, onChange, ...base }: DateFieldProps) {
  const { prefs } = useDateTimeFormat();
  const locale = appLocale();

  const rendered = useMemo(() => {
    const d = isoToDate(value);
    return d ? formatNumericDate(d, prefs, locale) : "";
  }, [value, prefs, locale]);

  const [draft, setDraft] = useDraft(rendered);
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    if (!draft.trim()) {
      setInvalid(Boolean(base.required));
      if (!base.required) onChange("");
      return;
    }
    const d = parseNumericDate(draft, prefs, locale);
    if (!d) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(isoDate(d));
  };

  const step = (delta: number) => {
    const base_ = parseNumericDate(draft, prefs, locale) ?? isoToDate(value);
    if (!base_) return;
    const next = new Date(base_);
    next.setDate(next.getDate() + delta);
    setInvalid(false);
    onChange(isoDate(next));
  };

  return (
    <TextFieldShell
      {...base}
      text={draft}
      onText={(t) => {
        setDraft(t);
        if (invalid) setInvalid(false);
      }}
      onCommit={commit}
      onStep={step}
      hint={datePlaceholder(prefs, locale)}
      invalid={invalid}
      invalidMessage={`Enter a date like ${datePlaceholder(prefs, locale)}.`}
    />
  );
}

export interface DateTimeFieldProps extends FieldBase {
  /** Wire value, always `YYYY-MM-DDTHH:MM` local. `""` means empty. */
  value: string;
  onChange: (next: string) => void;
  /** Accessible names for the two sub-fields, appended to `label`. */
  dateLabel?: string;
  timeLabel?: string;
}

/**
 * A local date-and-time field, rendered as a date field beside a time field.
 *
 * Two controls rather than one combined string: a single box would have to
 * parse a date *and* a time out of free text, where an ambiguous separator
 * makes it impossible to tell a failed date from a failed time — and this is
 * the field that decides when logged work started.
 */
export function DateTimeField({
  value,
  onChange,
  dateLabel,
  timeLabel,
  label,
  className,
  ...base
}: DateTimeFieldProps) {
  const [datePart, timePart] = splitLocal(value);

  // The two halves are held locally so a half-filled value survives being
  // typed. Reporting `""` upward for an incomplete pair (the shape callers
  // validate) and deriving both halves straight from `value` would mean the
  // date you just entered is discarded the moment it round-trips — making an
  // empty Start impossible to fill in date-then-time order.
  const [localDate, setLocalDate] = useState(datePart);
  const [localTime, setLocalTime] = useState(timePart);
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current !== value) {
      lastValue.current = value;
      const [d, t] = splitLocal(value);
      // An externally-cleared value resets both halves; a value that merely
      // echoes back what we just reported leaves the drafts alone.
      if (value || (!d && !t)) {
        setLocalDate(d);
        setLocalTime(t);
      }
    }
  }, [value]);

  const report = (d: string, t: string) => {
    if (d && t) onChange(joinLocal(d, t));
    else if (!d && !t) onChange("");
    // Exactly one half present: hold it locally and report nothing, so the
    // caller keeps seeing "not set" rather than a partial timestamp.
  };

  return (
    <span className="dt-field">
      <DateField
        {...base}
        label={dateLabel ?? `${label} date`}
        className={className}
        value={localDate}
        onChange={(next) => {
          setLocalDate(next);
          report(next, localTime);
        }}
      />
      <TimeField
        {...base}
        label={timeLabel ?? `${label} time`}
        className={className}
        value={localTime}
        onChange={(next) => {
          setLocalTime(next);
          report(localDate, next);
        }}
      />
    </span>
  );
}

/** `YYYY-MM-DDTHH:MM` → `["YYYY-MM-DD", "HH:MM"]`, tolerating seconds. */
export function splitLocal(value: string): [string, string] {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return m ? [m[1]!, m[2]!] : ["", ""];
}

/**
 * Recombine the halves. An incomplete pair yields `""` rather than a partial
 * timestamp: callers treat `""` as "not set" and validate it, whereas a
 * half-filled string would look like a real value and fail further in.
 */
export function joinLocal(date: string, time: string): string {
  if (!date || !time) return "";
  return `${date}T${time}`;
}
