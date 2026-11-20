import gleam/erlang/process
import herdr_web/config
import herdr_web/subprocess
import herdr_web/web
import mist

pub fn main() {
  let cfg = config.load()
  let assert Ok(_) = subprocess.start_supervisor()
  let assert Ok(_) =
    web.handle(cfg, _)
    |> mist.new
    |> mist.bind("127.0.0.1")
    |> mist.port(cfg.port)
    |> mist.start

  process.sleep_forever()
}
