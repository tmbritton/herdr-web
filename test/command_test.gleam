import gleeunit/should
import herdr_web/command

pub fn scroll_bounds_test() {
  command.decode(
    "{\"type\":\"scroll\",\"generation\":2,\"direction\":\"up\",\"steps\":3,\"column\":79,\"row\":23}",
  )
  |> should.be_ok
  command.decode(
    "{\"type\":\"scroll\",\"generation\":2,\"direction\":\"sideways\",\"steps\":1,\"column\":0,\"row\":0}",
  )
  |> should.be_error
  command.decode(
    "{\"type\":\"scroll\",\"generation\":2,\"direction\":\"down\",\"steps\":0,\"column\":0,\"row\":0}",
  )
  |> should.be_error
  command.decode(
    "{\"type\":\"scroll\",\"generation\":2,\"direction\":\"down\",\"steps\":9,\"column\":0,\"row\":0}",
  )
  |> should.be_error
  command.decode(
    "{\"type\":\"scroll\",\"generation\":2,\"direction\":\"down\",\"steps\":1,\"column\":1000,\"row\":0}",
  )
  |> should.be_error
  command.decode(
    "{\"type\":\"scroll\",\"generation\":2,\"direction\":\"down\",\"steps\":1,\"column\":0,\"row\":-1}",
  )
  |> should.be_error
}

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
