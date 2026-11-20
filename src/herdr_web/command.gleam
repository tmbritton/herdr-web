pub type Command {
  Ping(generation: Int)
  Ack(generation: Int, seq: Int)
  Control(generation: Int, takeover: Bool)
  Release(generation: Int)
  Input(generation: Int, text: String)
  Resize(generation: Int, cols: Int, rows: Int)
}

pub fn decode(text: String) -> Result(Command, String) {
  let decoder = {
    use kind <- d.field("type", d.string)
    use generation <- d.field("generation", d.int)
    case kind {
      "ping" -> d.success(Ping(generation))
      "ack" -> {
        use seq <- d.field("seq", d.int)
        d.success(Ack(generation, seq))
      }
      "control" -> {
        use takeover <- d.field("takeover", d.bool)
        d.success(Control(generation, takeover))
      }
      "release" -> d.success(Release(generation))
      "input" -> {
        use text <- d.field("text", d.string)
        d.success(Input(generation, text))
      }
      "resize" -> {
        use cols <- d.field("cols", d.int)
        use rows <- d.field("rows", d.int)
        d.success(Resize(generation, cols, rows))
      }
      _ -> d.failure(Release(0), "known client command")
    }
  }
  case bit_array.byte_size(bit_array.from_string(text)) > 65_536 {
    True -> Error("message_too_large")
    False -> {
      use cmd <- result.try(
        json.parse(text, decoder)
        |> result.replace_error("invalid_client_message"),
      )
      case generation(cmd) > 0 {
        False -> Error("invalid_generation")
        True ->
          case cmd {
            Resize(_, cols, rows)
              if cols < 1 || cols > 400 || rows < 1 || rows > 200
            -> Error("invalid_dimensions")
            Input(_, text) ->
              case bit_array.byte_size(bit_array.from_string(text)) <= 16_384 {
                True -> Ok(cmd)
                False -> Error("input_too_large")
              }
            _ -> Ok(cmd)
          }
      }
    }
  }
}

pub fn generation(cmd: Command) -> Int {
  case cmd {
    Ping(g)
    | Ack(g, _)
    | Control(g, _)
    | Release(g)
    | Input(g, _)
    | Resize(g, _, _) -> g
  }
}

import gleam/bit_array
import gleam/dynamic/decode as d
import gleam/json
import gleam/result
