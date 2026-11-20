import gleeunit/should
import herdr_web/command

pub fn explicit_control_and_epoch_test() {
  command.decode("{\"type\":\"ping\",\"generation\":2}")
  |> should.equal(Ok(command.Ping(2)))
  command.decode("{\"type\":\"control\",\"generation\":2,\"takeover\":false}")
  |> should.equal(Ok(command.Control(2, False)))
  command.decode("{\"type\":\"input\",\"generation\":2,\"text\":\"hello\\n\"}")
  |> should.equal(Ok(command.Input(2, "hello\n")))
  command.decode("{\"type\":\"input\",\"text\":\"no epoch\"}")
  |> should.be_error
}

pub fn resize_bounds_test() {
  command.decode(
    "{\"type\":\"resize\",\"generation\":2,\"cols\":80,\"rows\":24}",
  )
  |> should.equal(Ok(command.Resize(2, 80, 24)))
  command.decode(
    "{\"type\":\"resize\",\"generation\":2,\"cols\":0,\"rows\":24}",
  )
  |> should.be_error
  command.decode(
    "{\"type\":\"resize\",\"generation\":2,\"cols\":99999,\"rows\":24}",
  )
  |> should.be_error
  command.decode("{\"type\":\"control\",\"generation\":2,\"takeover\":\"yes\"}")
  |> should.be_error
}
