/**
 * User-chosen date and time formats (#308).
 *
 * Cairn used to render every clock as zero-padded 24-hour and every date in
 * whatever order the locale implied, with no way to say otherwise. This module
 * owns the preference and the pure formatting/parsing built on it; the store
 * that persists it lives in `use-datetime-format.ts`.
 *
 * Kept free of React and of `localStorage` so every formatter is a pure
 * function of (value, prefs, locale) and can be tested without a DOM.
 */

/** How to render a time of day. `system` follows the OS locale's convention. */
export type TimeFormat = "system" | "24h" | "12h";

/**
 * Field order for numeric dates. `system` follows the OS locale. The three
 * explicit orders cover what people actually ask for; anything finer (custom
 * separators, two-digit years) is deliberately not offered — it multiplies the
 * parsing surface of the date inputs for very little gain.
 */
export type DateFormat = "system" | "dmy" | "mdy" | "ymd";

export interface DateTimeFormatPrefs {
  time: TimeFormat;
  date: DateFormat;
}

/** Both default to following the OS, which is what most users expect and what
 *  Cairn already did for dates before this setting existed. */
export const DATETIME_FORMAT_DEFAULT: DateTimeFormatPrefs = {
  time: "system",
  date: "system",
};

const TIME_FORMATS: readonly TimeFormat[] = ["system", "24h", "12h"];
const DATE_FORMATS: readonly DateFormat[] = ["system", "dmy", "mdy", "ymd"];

/** Narrow an unknown (a parsed localStorage blob) to a valid preference. */
export function coerceFormatPrefs(raw: unknown): DateTimeFormatPrefs {
  const o = (raw ?? {}) as Partial<Record<keyof DateTimeFormatPrefs, unknown>>;
  return {
    time: TIME_FORMATS.includes(o.time as TimeFormat)
      ? (o.time as TimeFormat)
      : DATETIME_FORMAT_DEFAULT.time,
    date: DATE_FORMATS.includes(o.date as DateFormat)
      ? (o.date as DateFormat)
      : DATETIME_FORMAT_DEFAULT.date,
  };
}

/**
 * Whether to render a 12-hour clock.
 *
 * For `system`, ask `Intl` what the locale does rather than keeping a list of
 * 12-hour locales. `hour12` is the direct answer; `hourCycle` is the fallback
 * for engines that don't report it (`h11`/`h12` are the 12-hour cycles). If
 * neither is available the answer is 24-hour, matching what Cairn rendered
 * before this preference existed.
 */
export function resolveHour12(
  prefs: DateTimeFormatPrefs,
  locale: string,
): boolean {
  if (prefs.time === "12h") return true;
  if (prefs.time === "24h") return false;
  try {
    // `hourCycle` is widely implemented but absent from the DOM lib types
    // this project targets, so it's read through a narrow structural type
    // rather than by widening the tsconfig lib.
    const opts = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
    }).resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & {
      hourCycle?: string;
    };
    if (typeof opts.hour12 === "boolean") return opts.hour12;
    return opts.hourCycle === "h11" || opts.hourCycle === "h12";
  } catch {
    return false;
  }
}

/**
 * Format an hour/minute pair as a clock reading.
 *
 * 24-hour output is built by hand as `HH:MM` rather than handed to `Intl`
 * deliberately: some locales render a 24-hour clock as `14.05`, and Cairn's
 * timeline axis, entry rows and design mockups are all `14:05`. A colon is
 * unambiguous in every locale, so the preference controls the *clock*, not the
 * separator. 12-hour output does go through `Intl`, because where the
 * day-period marker sits (and what it reads) genuinely is locale business.
 */
export function formatClockParts(
  hours: number,
  minutes: number,
  prefs: DateTimeFormatPrefs,
  locale: string,
): string {
  if (!resolveHour12(prefs, locale)) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  // A fixed date carrying the requested wall-clock time; only the time parts
  // are formatted, so the date itself never surfaces.
  const probe = new Date(2000, 0, 1, hours, minutes);
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(probe);
  } catch {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
}

/** The explicit field order for a non-`system` date preference. */
const FIELD_ORDER: Record<Exclude<DateFormat, "system">, readonly string[]> = {
  dmy: ["day", "month", "year"],
  mdy: ["month", "day", "year"],
  ymd: ["year", "month", "day"],
};

/**
 * Format a date as an all-numeric date (the form the date inputs round-trip).
 * `ymd` uses `-` and the others `/`, matching each order's usual written form.
 */
export function formatNumericDate(
  date: Date,
  prefs: DateTimeFormatPrefs,
  locale: string,
): string {
  if (Number.isNaN(date.getTime())) return "—";
  if (prefs.date === "system") {
    try {
      return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    } catch {
      return isoDate(date);
    }
  }
  const parts: Record<string, string> = {
    year: String(date.getFullYear()).padStart(4, "0"),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0"),
  };
  const sep = prefs.date === "ymd" ? "-" : "/";
  return FIELD_ORDER[prefs.date].map((f) => parts[f]).join(sep);
}

/**
 * The field order a numeric date input should present, resolved for `system`
 * by asking `Intl` how this locale actually orders the parts. Drives both the
 * segment order of the custom date input and its placeholder.
 */
export function resolveDateOrder(
  prefs: DateTimeFormatPrefs,
  locale: string,
): readonly ("day" | "month" | "year")[] {
  if (prefs.date !== "system") {
    return FIELD_ORDER[prefs.date] as readonly ("day" | "month" | "year")[];
  }
  try {
    const order = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(2000, 0, 2))
      .filter(
        (p) => p.type === "day" || p.type === "month" || p.type === "year",
      )
      .map((p) => p.type as "day" | "month" | "year");
    // A locale that somehow didn't yield all three parts would produce a date
    // input missing a segment, so fall back rather than trust a short list.
    if (order.length === 3) return order;
  } catch {
    /* fall through to the most common order */
  }
  return FIELD_ORDER.dmy as readonly ("day" | "month" | "year")[];
}

/**
 * The day heading shown when the Today view is scrolled to another date —
 * a short weekday plus the day itself, e.g. `Mon, 3 Mar`.
 *
 * Weekday and month names always come from the locale; only the *order* of
 * day and month follows the preference. `ymd` gets the full ISO date rather
 * than a reordered short form, because that's the shape someone choosing
 * year-first is asking for and `Mon, 03-03` reads as neither.
 */
export function formatDayLabel(
  date: Date,
  prefs: DateTimeFormatPrefs,
  locale: string,
): string {
  if (Number.isNaN(date.getTime())) return "—";
  const named = (opts: Intl.DateTimeFormatOptions): string => {
    try {
      return new Intl.DateTimeFormat(locale, opts).format(date);
    } catch {
      return "";
    }
  };
  if (prefs.date === "system") {
    const full = named({ weekday: "short", month: "short", day: "numeric" });
    if (full) return full;
  }
  const weekday = named({ weekday: "short" });
  const month = named({ month: "short" });
  const day = String(date.getDate());
  const prefix = weekday ? `${weekday}, ` : "";
  if (prefs.date === "ymd") return `${prefix}${isoDate(date)}`;
  if (prefs.date === "mdy") return `${prefix}${month} ${day}`;
  return `${prefix}${day} ${month}`;
}

/** `YYYY-MM-DD` in local time — the wire form the backend and `<input>`s use. */
export function isoDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
