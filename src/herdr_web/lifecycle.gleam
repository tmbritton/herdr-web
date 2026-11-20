import gleam/option.{type Option, None, Some}

pub type Timeouts {
  Timeouts(initial: Int, render: Int, idle: Int)
}

pub fn defaults() -> Timeouts {
  Timeouts(8000, 10_000, 20_000)
}

pub fn expired(
  now: Int,
  started: Int,
  last_client: Int,
  has_frame: Bool,
  waiting_since: Option(Int),
  timeouts: Timeouts,
) -> Option(String) {
  case has_frame, waiting_since {
    False, _ if now - started >= timeouts.initial -> Some("attach_timeout")
    _, Some(sent) if now - sent >= timeouts.render -> Some("render_timeout")
    _, _ if now - last_client >= timeouts.idle -> Some("heartbeat_timeout")
    _, _ -> None
  }
}

@external(erlang, "herdr_web_runtime", "monotonic_milliseconds")
pub fn now() -> Int
