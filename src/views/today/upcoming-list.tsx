import { Empty } from "../../lib/components";
import { fmtClockFromIso } from "../../lib/time";

export interface UpcomingEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

interface Props {
  events: UpcomingEvent[];
  onStart?: (event: UpcomingEvent) => void;
  calendarsConnected: boolean;
}

export function UpcomingList({ events, onStart, calendarsConnected }: Props) {
  if (events.length === 0) {
    if (!calendarsConnected) {
      return (
        <Empty
          title="No calendar connected"
          body="Add a calendar subscription in Settings to see upcoming events here."
          tone="soft"
        />
      );
    }
    return (
      <Empty
        title="Nothing scheduled"
        body="Calendar events show up here as they approach."
        tone="soft"
      />
    );
  }
  return (
    <ul className="up-list">
      {events.map((e) => {
        const duration = durationMinutes(e.start, e.end);
        const time = e.allDay ? "all day" : fmtClockFromIso(e.start);
        const label = e.summary || "(no title)";
        const durLabel = e.allDay ? "" : `${duration}m`;
        return (
          <li key={e.uid} className="up-item">
            <button
              type="button"
              className="up-btn"
              onClick={() => onStart?.(e)}
              aria-label={`Start timer for ${label} at ${time}`}
            >
              <span className="up-time">{time}</span>
              <span className="up-label">{label}</span>
              {durLabel && <span className="up-dur">{durLabel}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function durationMinutes(start: string, end: string): number {
  // Calendar event timestamps come from the backend's RFC3339 — never NaN.
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Math.max(0, Math.round((e - s) / 60_000));
}
