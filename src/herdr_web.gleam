import gleam/erlang/process
import herdr_web/subprocess
import herdr_web/web
import mist

pub fn main() {
  let assert Ok(_) = subprocess.start_supervisor()
  let assert Ok(_) =
    web.handle_request
    |> mist.new
    |> mist.bind("127.0.0.1")
    |> mist.port(3000)
    |> mist.start

  process.sleep_forever()
}
