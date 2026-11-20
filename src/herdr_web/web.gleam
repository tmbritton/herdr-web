import gleam/bytes_tree
import gleam/http.{Get, Head}
import gleam/http/request.{type Request}
import gleam/http/response.{type Response}
import mist.{type ResponseData}

// The handler does not depend on the request body until streaming is added.
pub fn handle_request(req: Request(body)) -> Response(ResponseData) {
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
    "/" ->
      response.new(200)
      |> response.set_header("content-type", "text/html; charset=utf-8")
      |> response.set_body(mist.Bytes(bytes_tree.from_string(index)))
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

const index =
  "<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
    <title>Herdr Web Terminal Bridge</title>
    <style>
      :root { color-scheme: light dark; font: 1rem/1.6 system-ui, sans-serif; }
      body { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Herdr Web Terminal Bridge</h1>
      <p>The Gleam/Mist server is running.</p>
      <p>Next milestone: stream an existing Herdr pane into this browser.</p>
      <p>Terminal viewing and control are not implemented yet.</p>
      <a href=\"/healthz\">Server health</a>
    </main>
  </body>
</html>
"
