import gleam/erlang/process.{type Pid}
import gleam/result

pub type Event {
  Line(String)
  // Stderr is arbitrary OS bytes, potentially truncated inside a UTF-8 sequence.
  Exited(Int, BitArray)
  Failed(String)
}

@external(erlang, "herdr_web_process_sup", "start")
pub fn start_supervisor() -> Result(Pid, String)

@external(erlang, "herdr_web_process", "start")
pub fn start(
  executable: String,
  arguments: List(String),
  owner: Pid,
  notify: fn(Event) -> Nil,
) -> Result(Pid, String)

@external(erlang, "herdr_web_process", "demand")
pub fn demand(worker: Pid) -> Nil

@external(erlang, "herdr_web_process", "write")
pub fn write(worker: Pid, data: String) -> Result(Nil, String)

@external(erlang, "herdr_web_process", "stop")
pub fn stop(worker: Pid) -> Nil

pub fn run(
  executable: String,
  arguments: List(String),
) -> Result(String, String) {
  let events = process.new_subject()
  use worker <- result.try(
    start(executable, arguments, process.self(), fn(event) {
      process.send(events, event)
    }),
  )
  demand(worker)
  let response = case process.receive(events, 2000) {
    Ok(Line(line)) -> {
      demand(worker)
      case process.receive(events, 2000) {
        Ok(Exited(0, _)) -> Ok(line)
        _ -> Error("command_failed")
      }
    }
    _ -> Error("command_failed")
  }
  stop(worker)
  response
}
