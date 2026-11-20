import exception
import gleam/bit_array
import gleam/erlang/process
import gleeunit/should
import herdr_web/subprocess as child

pub fn fragmented_lines_and_credit_test() {
  let events = process.new_subject()
  let assert Ok(worker) =
    child.start(
      "/bin/sh",
      ["-c", "printf one; sleep 0.02; printf '\\ntwo\\n'"],
      process.self(),
      fn(event) { process.send(events, event) },
    )
  use <- exception.defer(fn() { child.stop(worker) })
  child.demand(worker)
  process.receive(events, 2000) |> should.equal(Ok(child.Line("one")))
  process.receive(events, 50) |> should.be_error
  child.demand(worker)
  process.receive(events, 2000) |> should.equal(Ok(child.Line("two")))
  process.receive(events, 2000) |> should.equal(Ok(child.Exited(0, <<>>)))
}

pub fn stdin_and_stderr_test() {
  let events = process.new_subject()
  let assert Ok(worker) =
    child.start(
      "/bin/sh",
      [
        "-c",
        "read -r line; printf '%s\\n' \"$line\"; printf diagnostic >&2; exit 7",
      ],
      process.self(),
      fn(event) { process.send(events, event) },
    )
  use <- exception.defer(fn() { child.stop(worker) })
  child.write(worker, "hello\n") |> should.equal(Ok(Nil))
  child.demand(worker)
  process.receive(events, 2000) |> should.equal(Ok(child.Line("hello")))
  process.receive(events, 2000)
  |> should.equal(Ok(child.Exited(7, bit_array.from_string("diagnostic"))))
}

pub fn output_limit_test() {
  let events = process.new_subject()
  let assert Ok(worker) =
    child.start("/bin/sh", ["-c", "yes overflowing"], process.self(), fn(event) {
      process.send(events, event)
    })
  use <- exception.defer(fn() { child.stop(worker) })
  process.receive(events, 2000)
  |> should.equal(Ok(child.Failed("output_overflow")))
}

pub fn owner_death_cleans_child_test() {
  owner_death_cleans_child() |> should.be_true
}

pub fn truncated_output_test() {
  let events = process.new_subject()
  let assert Ok(worker) =
    child.start("/usr/bin/printf", ["unfinished"], process.self(), fn(event) {
      process.send(events, event)
    })
  use <- exception.defer(fn() { child.stop(worker) })
  process.receive(events, 2000)
  |> should.equal(Ok(child.Failed("truncated_record")))
}

@external(erlang, "herdr_test_ffi", "owner_death_cleans_child")
fn owner_death_cleans_child() -> Bool

pub fn non_reader_input_is_bounded_test() {
  non_reader_input_is_bounded() |> should.be_true
}

pub fn cleanup_is_prompt_test() {
  cleanup_is_prompt() |> should.be_true
}

pub fn exit_write_race_test() {
  exit_write_race() |> should.be_true
}

pub fn stderr_retains_bytes_at_unicode_boundary_test() {
  let events = process.new_subject()
  let assert Ok(worker) =
    child.start(
      "/bin/sh",
      ["-c", "{ printf '%4095s' ''; printf '\\342\\202\\254'; } >&2"],
      process.self(),
      fn(event) { process.send(events, event) },
    )
  use <- exception.defer(fn() { child.stop(worker) })
  let assert Ok(child.Exited(0, diagnostic)) = process.receive(events, 2000)
  bit_array.byte_size(diagnostic) |> should.equal(4096)
  bit_array.to_string(diagnostic) |> should.be_error
}

@external(erlang, "herdr_test_ffi", "non_reader_input_is_bounded")
fn non_reader_input_is_bounded() -> Bool

@external(erlang, "herdr_test_ffi", "cleanup_is_prompt")
fn cleanup_is_prompt() -> Bool

@external(erlang, "herdr_test_ffi", "exit_write_race")
fn exit_write_race() -> Bool
