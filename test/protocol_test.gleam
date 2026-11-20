import gleam/bit_array
import gleeunit/should
import herdr_web/protocol.{Closed, Frame, FrameEvent}

pub fn initial_frame_test() {
  protocol.decode(
    "{\"type\":\"terminal.frame\",\"seq\":1,\"encoding\":\"ansi\",\"width\":120,\"height\":40,\"full\":true,\"bytes\":\"G1sySmhp\"}",
  )
  |> should.equal(
    Ok(
      FrameEvent(Frame(1, 120, 40, True, bit_array.from_string("\u{1b}[2Jhi"))),
    ),
  )
}

pub fn closed_event_test() {
  protocol.decode("{\"type\":\"terminal.closed\",\"reason\":\"pane closed\"}")
  |> should.equal(Ok(Closed("pane closed")))
}

pub fn rejects_corrupt_frames_test() {
  protocol.decode("not json") |> should.be_error
  protocol.decode(
    "{\"type\":\"terminal.frame\",\"seq\":1,\"encoding\":\"ansi\",\"width\":0,\"height\":40,\"full\":true,\"bytes\":\"AA==\"}",
  )
  |> should.be_error
  protocol.decode(
    "{\"type\":\"terminal.frame\",\"seq\":1,\"encoding\":\"ansi\",\"width\":80,\"height\":24,\"full\":true,\"bytes\":\"%%%\"}",
  )
  |> should.be_error
  protocol.decode("{\"type\":\"unknown\"}") |> should.be_error
}
