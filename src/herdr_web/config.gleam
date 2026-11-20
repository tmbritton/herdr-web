pub type Config {
  Config(
    executable: String,
    prefix: List(String),
    origins: List(String),
    port: Int,
    timeouts: lifecycle.Timeouts,
  )
}

pub fn default() -> Config {
  Config(
    "herdr",
    [],
    ["http://127.0.0.1:3000", "http://localhost:3000"],
    3000,
    lifecycle.defaults(),
  )
}

pub fn load() -> Config {
  let cfg = default()
  let prefix = case env("HERDR_WEB_SESSION") {
    Ok(name) if name != "" -> ["--session", name]
    _ -> []
  }
  let origins = case env("HERDR_WEB_ORIGINS") {
    Ok(value) -> string.split(value, ",") |> list.map(string.trim)
    _ -> cfg.origins
  }
  let port =
    env("HERDR_WEB_PORT") |> result.try(int.parse) |> result.unwrap(3000)
  let assert True = port > 0 && port < 65_536
  Config(
    env("HERDR_WEB_EXECUTABLE") |> result.unwrap("herdr"),
    prefix,
    origins,
    port,
    cfg.timeouts,
  )
}

pub fn allowed_origin(config: Config, origin: String) -> Bool {
  list.contains(config.origins, origin)
}

pub fn allowed_host(config: Config, host: String) -> Bool {
  allowed_origin(config, "http://" <> host)
  || allowed_origin(config, "https://" <> host)
}

pub fn valid_pane(pane: String) -> Bool {
  case string.split(pane, ":") {
    ["w" <> workspace, "p" <> pane] ->
      canonical_number(workspace) && canonical_number(pane)
    _ -> False
  }
}

fn canonical_number(value: String) -> Bool {
  case int.parse(value) {
    Ok(n) -> n > 0 && int.to_string(n) == value
    _ -> False
  }
}

@external(erlang, "herdr_web_runtime", "env")
fn env(name: String) -> Result(String, Nil)

import gleam/int
import gleam/list
import gleam/result
import gleam/string
import herdr_web/lifecycle
