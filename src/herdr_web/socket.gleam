import gleam/erlang/process.{type Pid, type Subject}
import gleam/http/request.{type Request}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import herdr_web/command
import herdr_web/config.{type Config}
import herdr_web/protocol
import herdr_web/subprocess as child
import mist

type Mode {
  Watch
  RequestingControl
  Controlling
}

type Message {
  Output(Int, child.Event)
  WorkerDown(process.Down)
}

type State {
  State(
    worker: Option(Pid),
    monitor: Option(process.Monitor),
    seq: Int,
    waiting: Bool,
    events: Subject(Message),
    generation: Int,
    mode: Mode,
    cfg: Config,
    pane: String,
    cols: Int,
    rows: Int,
    requested_size: #(Int, Int),
  )
}

pub fn upgrade(req: Request(mist.Connection), cfg: Config, pane: String) {
  mist.websocket(
    req,
    on_init: fn(_) {
      let events = process.new_subject()
      let selector =
        process.new_selector()
        |> process.select(events)
        |> process.select_monitors(WorkerDown)
      let state =
        State(None, None, 0, False, events, 0, Watch, cfg, pane, 120, 40, #(
          0,
          0,
        ))
      #(open(state, Watch, False), Some(selector))
    },
    on_close: close,
    handler: handle,
  )
}

fn open(state: State, mode: Mode, takeover: Bool) -> State {
  close(state)
  let generation = state.generation + 1
  let args = case mode {
    Watch -> ["terminal", "session", "observe", state.pane]
    _ ->
      list.append(
        [
          "terminal",
          "session",
          "control",
          state.pane,
          "--cols",
          int.to_string(state.cols),
          "--rows",
          int.to_string(state.rows),
        ],
        case takeover {
          True -> ["--takeover"]
          False -> []
        },
      )
  }
  let worker =
    child.start(
      state.cfg.executable,
      list.append(state.cfg.prefix, args),
      process.self(),
      fn(event) { process.send(state.events, Output(generation, event)) },
    )
  let #(worker, monitor) = case worker {
    Ok(pid) -> {
      let monitor = process.monitor(pid)
      child.demand(pid)
      #(Some(pid), Some(monitor))
    }
    Error(reason) -> {
      process.send(state.events, Output(generation, child.Failed(reason)))
      #(None, None)
    }
  }
  State(
    ..state,
    worker: worker,
    monitor: monitor,
    seq: 0,
    waiting: False,
    generation: generation,
    mode: mode,
    requested_size: #(0, 0),
  )
}

fn handle(state: State, message, connection) {
  case message {
    mist.Custom(Output(generation, _)) if generation != state.generation ->
      mist.continue(state)
    mist.Custom(Output(_, child.Line(line))) ->
      case protocol.decode(line) {
        Ok(protocol.FrameEvent(frame))
          if frame.seq > state.seq && !state.waiting
        -> {
          case state.seq == 0 && !frame.full {
            True -> fail(connection, "initial_snapshot_required")
            False -> {
              let state =
                State(..state, mode: case state.mode {
                  RequestingControl -> Controlling
                  other -> other
                })
              case state.seq {
                0 -> send_mode(connection, state, "")
                _ -> Nil
              }
              let meta =
                json.object([
                  #("type", json.string("frame")),
                  #("generation", json.int(state.generation)),
                  #("seq", json.int(frame.seq)),
                  #("cols", json.int(frame.cols)),
                  #("rows", json.int(frame.rows)),
                  #("full", json.bool(frame.full)),
                ])
                |> json.to_string
              case
                mist.send_text_frame(connection, meta),
                mist.send_binary_frame(connection, frame.bytes)
              {
                Ok(_), Ok(_) ->
                  mist.continue(
                    State(
                      ..state,
                      seq: frame.seq,
                      waiting: True,
                      cols: frame.cols,
                      rows: frame.rows,
                    ),
                  )
                _, _ -> mist.stop()
              }
            }
          }
        }
        Ok(protocol.Closed(reason)) -> {
          case state.mode {
            Watch -> fail(connection, "pane_closed")
            _ ->
              change(
                state,
                Watch,
                False,
                connection,
                case string.contains(reason, "already has an attached client") {
                  True -> "control_busy"
                  False -> "control_released"
                },
              )
          }
        }
        _ -> fail(connection, "invalid_terminal_stream")
      }
    mist.Custom(Output(_, child.Failed(reason))) ->
      failed(state, connection, reason)
    mist.Custom(Output(_, child.Exited(_, _))) ->
      failed(state, connection, "attachment_ended")
    mist.Custom(WorkerDown(process.ProcessDown(_, pid, _))) -> {
      case state.worker {
        Some(current) if pid == current ->
          failed(state, connection, "attachment_ended")
        _ -> mist.continue(state)
      }
    }
    mist.Custom(WorkerDown(_)) -> mist.continue(state)
    mist.Text(text) ->
      case command.decode(text) {
        Ok(cmd) -> {
          case command.generation(cmd) {
            generation if generation < state.generation -> mist.continue(state)
            generation if generation == state.generation ->
              handle_command(state, cmd, connection)
            _ -> fail(connection, "invalid_generation")
          }
        }
        Error(reason) -> fail(connection, reason)
      }
    mist.Binary(_) -> fail(connection, "invalid_client_message")
    mist.Closed | mist.Shutdown -> mist.stop()
  }
}

fn handle_command(state: State, cmd: command.Command, connection) {
  case cmd, state.worker {
    command.Ack(_, seq), Some(worker) if seq == state.seq && state.waiting -> {
      child.demand(worker)
      mist.continue(State(..state, waiting: False))
    }
    command.Control(_, takeover), _ if state.mode == Watch && state.seq > 0 ->
      change(state, RequestingControl, takeover, connection, "")
    command.Release(_), _ ->
      change(state, Watch, False, connection, "control_released")
    command.Input(_, text), Some(worker) if state.mode == Controlling ->
      write(
        state,
        worker,
        json.object([
          #("type", json.string("terminal.input")),
          #("text", json.string(text)),
        ]),
        connection,
      )
    command.Resize(_, cols, rows), Some(worker) if state.mode == Controlling -> {
      case state.requested_size == #(cols, rows) {
        True -> mist.continue(state)
        False ->
          write(
            State(..state, requested_size: #(cols, rows)),
            worker,
            json.object([
              #("type", json.string("terminal.resize")),
              #("cols", json.int(cols)),
              #("rows", json.int(rows)),
            ]),
            connection,
          )
      }
    }
    _, _ -> fail(connection, "command_not_allowed")
  }
}

fn write(state, worker, message, connection) {
  case child.write(worker, json.to_string(message) <> "\n") {
    Ok(_) -> mist.continue(state)
    Error(reason) -> failed(state, connection, reason)
  }
}

fn failed(state: State, connection, reason) {
  case state.mode {
    Watch -> fail(connection, reason)
    _ -> change(state, Watch, False, connection, "control_lost")
  }
}

fn change(state, mode, takeover, connection, reason) {
  let next = open(state, mode, takeover)
  send_mode(connection, next, reason)
  mist.continue(next)
}

fn send_mode(connection, state: State, reason: String) {
  let mode = case state.mode {
    Watch -> "watch"
    RequestingControl -> "requesting-control"
    Controlling -> "control"
  }
  let _ =
    mist.send_text_frame(
      connection,
      json.object([
        #("type", json.string("mode")),
        #("mode", json.string(mode)),
        #("generation", json.int(state.generation)),
        #("reason", json.string(reason)),
      ])
        |> json.to_string,
    )
  Nil
}

fn close(state: State) {
  case state.monitor {
    Some(monitor) -> process.demonitor_process(monitor)
    None -> Nil
  }
  case state.worker {
    Some(worker) -> child.stop(worker)
    None -> Nil
  }
}

fn fail(connection, reason: String) {
  let _ =
    mist.send_text_frame(
      connection,
      json.object([
        #("type", json.string("error")),
        #("reason", json.string(reason)),
      ])
        |> json.to_string,
    )
  mist.stop()
}
