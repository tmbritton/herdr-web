import gleam/bytes_tree
import gleam/http.{Get, Head}
import gleam/http/request.{type Request}
import gleam/http/response.{type Response}
import gleam/list
import gleam/result
import gleam/uri
import herdr_web/config.{type Config}
import herdr_web/socket
import herdr_web/subprocess
import mist.{type ResponseData}

// The handler does not depend on the request body until streaming is added.
pub fn handle_request(req: Request(mist.Connection)) -> Response(ResponseData) {
  handle(config.default(), req)
}

pub fn handle(
  cfg: Config,
  req: Request(mist.Connection),
) -> Response(ResponseData) {
  case req.method, request.path_segments(req) {
    Get, ["api", "panes"] -> {
      let host = request.get_header(req, "host") |> result.unwrap("")
      let res = case config.allowed_host(cfg, host) {
        False -> text(403, "Forbidden\n")
        True ->
          case
            subprocess.run(
              cfg.executable,
              list.append(cfg.prefix, ["api", "snapshot"]),
            )
          {
            Ok(body) ->
              text(200, body)
              |> response.set_header("content-type", "application/json")
            Error(_) -> text(503, "Herdr discovery unavailable\n")
          }
      }
      res
      |> response.set_header("connection", "close")
      |> response.set_header("cache-control", "no-store")
    }
    Get, ["ws", encoded] -> {
      let pane = uri.percent_decode(encoded) |> result.unwrap("")
      let origins =
        list.filter(req.headers, fn(header) { header.0 == "origin" })
      let host = request.get_header(req, "host") |> result.unwrap("")
      case origins {
        [#(_, origin)] if origin != "" -> {
          case
            config.allowed_origin(cfg, origin)
            && config.allowed_host(cfg, host)
            && config.valid_pane(pane)
          {
            True -> socket.upgrade(req, cfg, pane)
            False ->
              text(403, "Forbidden\n")
              |> response.set_header("connection", "close")
          }
        }
        _ ->
          text(403, "Forbidden\n") |> response.set_header("connection", "close")
      }
    }
    _, _ -> ordinary(req)
  }
}

fn ordinary(req: Request(body)) -> Response(ResponseData) {
  let res = case req.method {
    Get | Head -> get(req.path)
    _ ->
      text(405, "Method not allowed\n")
      |> response.set_header("allow", "GET, HEAD")
  }

  let res = case req.method {
    Head -> response.set_body(res, mist.Bytes(bytes_tree.new()))
    _ -> res
  }

  // These routes do not consume request bodies. Closing the connection prevents
  // unread body bytes from being interpreted as a subsequent HTTP request.
  response.set_header(res, "connection", "close")
}

fn get(path: String) -> Response(ResponseData) {
  case path {
    "/" -> asset_response("index.html", "text/html; charset=utf-8")
    "/assets/app.js" ->
      asset_response("app.js", "text/javascript; charset=utf-8")
    "/assets/app.css" -> asset_response("app.css", "text/css; charset=utf-8")
    // Liveness only: this does not imply that Herdr is connected or ready.
    "/healthz" -> text(200, "ok\n")
    _ -> text(404, "Not found\n")
  }
}

fn text(status: Int, body: String) -> Response(ResponseData) {
  response.new(status)
  |> response.set_header("content-type", "text/plain; charset=utf-8")
  |> response.set_body(mist.Bytes(bytes_tree.from_string(body)))
}

fn asset_response(name, content_type) {
  case asset(name) {
    Ok(bytes) ->
      response.new(200)
      |> response.set_header("content-type", content_type)
      |> response.set_header("cache-control", "no-cache")
      |> response.set_header("x-content-type-options", "nosniff")
      |> response.set_body(mist.Bytes(bytes_tree.from_bit_array(bytes)))
    Error(_) -> text(503, "Browser assets missing; run mise run build\n")
  }
}

@external(erlang, "herdr_web_runtime", "asset")
fn asset(name: String) -> Result(BitArray, Nil)
