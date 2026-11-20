import gleam/erlang/process.{type Pid}

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
