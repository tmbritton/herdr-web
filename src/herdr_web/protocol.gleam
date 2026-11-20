import gleam/bit_array
import gleam/dynamic/decode as d
import gleam/json
import gleam/result

pub type Frame {
  Frame(seq: Int, cols: Int, rows: Int, full: Bool, bytes: BitArray)
}

pub type Event {
  FrameEvent(Frame)
  Closed(String)
}

pub fn decode(line: String) -> Result(Event, String) {
  let decoder = {
    use kind <- d.field("type", d.string)
    case kind {
      "terminal.closed" -> {
        use reason <- d.field("reason", d.string)
        d.success(Ok(Closed(reason)))
      }
      "terminal.frame" -> {
        use encoding <- d.field("encoding", d.string)
        use seq <- d.field("seq", d.int)
        use cols <- d.field("width", d.int)
        use rows <- d.field("height", d.int)
        use full <- d.field("full", d.bool)
        use encoded <- d.field("bytes", d.string)
        let frame = case
          encoding == "ansi"
          && seq > 0
          && cols > 0
          && cols <= 1000
          && rows > 0
          && rows <= 500
        {
          False -> Error("invalid_frame_metadata")
          True ->
            bit_array.base64_decode(encoded)
            |> result.map(fn(bytes) {
              FrameEvent(Frame(seq, cols, rows, full, bytes))
            })
            |> result.replace_error("invalid_frame_bytes")
        }
        d.success(frame)
      }
      _ -> d.success(Error("unsupported_record"))
    }
  }
  use decoded <- result.try(
    json.parse(line, decoder) |> result.replace_error("invalid_record"),
  )
  decoded
}
