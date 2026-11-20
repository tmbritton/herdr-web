import exception
import gleam/erlang/process
import gleam/option.{None, Some}
import gleeunit/should
import herdr_web/config
import herdr_web/lifecycle
import herdr_web/web
import mist

pub fn initial_frame_deadline_test() {
  let limits = lifecycle.defaults()
  lifecycle.expired(7999, 0, 7999, False, None, limits) |> should.equal(None)
  lifecycle.expired(8000, 0, 8000, False, None, limits)
  |> should.equal(Some("attach_timeout"))
}

pub fn pings_cannot_extend_render_deadline_test() {
  let limits = lifecycle.defaults()
  lifecycle.expired(10_099, 0, 10_099, True, Some(100), limits)
  |> should.equal(None)
  lifecycle.expired(10_100, 0, 10_100, True, Some(100), limits)
  |> should.equal(Some("render_timeout"))
}

pub fn silent_controller_deadline_test() {
  let limits = lifecycle.defaults()
  lifecycle.expired(20_099, 0, 100, True, None, limits) |> should.equal(None)
  lifecycle.expired(20_100, 0, 100, True, None, limits)
  |> should.equal(Some("heartbeat_timeout"))
}

pub fn websocket_initial_timeout_test() {
  deadline_server(
    "read -r value",
    lifecycle.Timeouts(20, 5000, 5000),
    False,
    False,
    "attach_timeout",
  )
}

pub fn websocket_render_timeout_test() {
  deadline_server(
    frame_script,
    lifecycle.Timeouts(5000, 20, 5000),
    False,
    False,
    "render_timeout",
  )
}

pub fn websocket_idle_controller_timeout_test() {
  deadline_server(
    frame_script,
    lifecycle.Timeouts(5000, 5000, 20),
    True,
    True,
    "heartbeat_timeout",
  )
}

const frame_script =
  "printf '%s\\n' '{\"type\":\"terminal.frame\",\"seq\":1,\"encoding\":\"ansi\",\"width\":80,\"height\":24,\"full\":true,\"bytes\":\"aGk=\"}'; while IFS= read -r value; do :; done"

fn deadline_server(script, timeouts, ack, control, reason) {
  let cfg =
    config.Config(
      ..config.default(),
      executable: "/bin/sh",
      prefix: ["-c", script, "--"],
      timeouts: timeouts,
    )
  let listening = process.new_subject()
  let assert Ok(server) =
    web.handle(cfg, _)
    |> mist.new
    |> mist.bind("127.0.0.1")
    |> mist.port(0)
    |> mist.after_start(fn(port, _, _) { process.send(listening, port) })
    |> mist.start
  use <- exception.defer(fn() {
    process.unlink(server.pid)
    process.send_exit(server.pid)
  })
  let assert Ok(port) = process.receive(listening, 1000)
  socket_deadline(port, ack, control, reason) |> should.be_true
}

@external(erlang, "herdr_test_ffi", "socket_deadline")
fn socket_deadline(port: Int, ack: Bool, control: Bool, reason: String) -> Bool
