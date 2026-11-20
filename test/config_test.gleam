import gleeunit/should
import herdr_web/config

pub fn exact_origins_test() {
  let cfg = config.default()
  config.allowed_origin(cfg, "http://127.0.0.1:3000") |> should.be_true
  config.allowed_origin(cfg, "http://127.0.0.1:3000.evil.test")
  |> should.be_false
  config.allowed_origin(cfg, "null") |> should.be_false
  config.allowed_origin(cfg, "https://localhost:3000") |> should.be_false
}

pub fn explicit_pane_identifiers_only_test() {
  config.valid_pane("w9:p123") |> should.be_true
  config.valid_pane("--takeover") |> should.be_false
  config.valid_pane("w1:p1;sh") |> should.be_false
  config.valid_pane("w0:p0") |> should.be_false
  config.valid_pane("w01:p2") |> should.be_false
}
