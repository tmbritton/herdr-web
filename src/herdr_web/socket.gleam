import gleam/dynamic/decode as d
import gleam/erlang/process.{type Pid, type Subject}
import gleam/http/request.{type Request}
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import herdr_web/config.{type Config}
import herdr_web/protocol
import herdr_web/subprocess as child
import mist

type Message {
  Output(child.Event)
  WorkerDown(process.Down)
}

type State {
  State(worker: Option(Pid), seq: Int, waiting: Bool, events: Subject(Message))
}

pub fn upgrade(req: Request(mist.Connection), cfg: Config, pane: String) {
  mist.websocket(
    req,
    on_init: fn(_) {
      let events = process.new_subject()
      let worker =
        child.start(
          cfg.executable,
          list.append(cfg.prefix, ["terminal", "session", "observe", pane]),
          process.self(),
          fn(event) { process.send(events, Output(event)) },
        )
      let selector =
        process.new_selector()
        |> process.select(events)
        |> process.select_monitors(WorkerDown)
      let worker = case worker {
        Ok(pid) -> {
          let _ = process.monitor(pid)
          child.demand(pid)
          Some(pid)
        }
        Error(reason) -> {
          process.send(events, Output(child.Failed(reason)))
          None
        }
      }
      #(State(worker, 0, False, events), Some(selector))
    },
    on_close: fn(state) { close(state) },
    handler: handle,
  )
}

fn handle(state: State, message, connection) {
  case message {
    mist.Custom(Output(child.Line(line))) -> {
      case protocol.decode(line) {
        Ok(protocol.FrameEvent(frame))
          if frame.seq > state.seq && !state.waiting
        -> {
          case state.seq == 0 && !frame.full {
            True -> fail(connection, "initial_snapshot_required")
            False -> {
              let meta =
                json.object([
                  #("type", json.string("frame")),
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
                  mist.continue(State(..state, seq: frame.seq, waiting: True))
                _, _ -> mist.stop()
              }
            }
          }
        }
        Ok(protocol.Closed(_)) -> fail(connection, "pane_closed")
        _ -> fail(connection, "invalid_terminal_stream")
      }
    }
    mist.Custom(Output(child.Failed(reason))) -> fail(connection, reason)
    mist.Custom(Output(child.Exited(_, _))) ->
      fail(connection, "attachment_ended")
    mist.Custom(WorkerDown(_)) -> fail(connection, "attachment_ended")
    mist.Text(text) -> {
      let ack = {
        use kind <- d.field("type", d.string)
        use seq <- d.field("seq", d.int)
        d.success(#(kind, seq))
      }
      case json.parse(text, ack), state.worker {
        Ok(#("ack", seq)), Some(worker) if seq == state.seq && state.waiting -> {
          child.demand(worker)
          mist.continue(State(..state, waiting: False))
        }
        _, _ -> fail(connection, "invalid_client_message")
      }
    }
    mist.Binary(_) -> fail(connection, "invalid_client_message")
    mist.Closed | mist.Shutdown -> mist.stop()
  }
}

fn close(state: State) {
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
