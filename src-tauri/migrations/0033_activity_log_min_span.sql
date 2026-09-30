-- Minimum activity length for the review surface (#313). Short foreground
-- blips (a 30-second glance at Slack) are recorded but are noise in the
-- "review your day" list and in the unreviewed count behind the "Workday in
-- Review" banner. This setting is the floor a span must reach to be offered
-- for review; it never affects what is recorded, so "Time by app" totals stay
-- complete and lowering the floor reveals history retroactively.
--
-- Default 5 minutes, which is also the lowest selectable value.

ALTER TABLE app_state ADD COLUMN activity_log_min_span_minutes INTEGER NOT NULL DEFAULT 5;
