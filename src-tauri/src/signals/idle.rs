//! Idle detection. Seconds since the last user input from any
//! attached input device (keyboard, mouse, trackpad).

use user_idle::UserIdle;

pub fn seconds_since_input() -> Option<u64> {
    UserIdle::get_time().ok().map(|t| t.as_seconds())
}
