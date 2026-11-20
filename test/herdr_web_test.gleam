import exception
import gleam/erlang/process
import gleam/http.{Get, Head, Post}
import gleam/http/request
import gleam/http/response
import gleam/httpc
import gleam/int
import gleam/string
import gleeunit
import gleeunit/should
import herdr_web/web
import mist

pub fn main() {
  gleeunit.main()
}

// Exercise a real listener on an OS-assigned port, without needing Herdr or
// conflicting with a development/service instance on port 3000.
pub fn http_server_test() {
  let listening = process.new_subject()
  let assert Ok(server) =
    web.handle_request
    |> mist.new
    |> mist.bind("127.0.0.1")
    |> mist.port(0)
    |> mist.after_start(fn(port, _, _) { process.send(listening, port) })
    |> mist.start

  use <- exception.defer(fn() {
    process.unlink(server.pid)
    process.send_exit(server.pid)
  })

  let assert Ok(port) = process.receive(listening, 1000)
  let base = "http://127.0.0.1:" <> int.to_string(port)

  let health = send(base <> "/healthz", Get)
  health.status |> should.equal(200)
  health.body |> should.equal("ok\n")

  let page = send(base <> "/", Get)
  page.status |> should.equal(200)
  response.get_header(page, "content-type")
  |> should.equal(Ok("text/html; charset=utf-8"))
  string.contains(page.body, "Herdr Web Terminal Bridge") |> should.be_true

  let head = send(base <> "/healthz", Head)
  head.status |> should.equal(200)
  head.body |> should.equal("")

  let missing = send(base <> "/missing", Get)
  missing.status |> should.equal(404)

  let rejected = send(base <> "/healthz", Post)
  rejected.status |> should.equal(405)
  response.get_header(rejected, "allow") |> should.equal(Ok("GET, HEAD"))
  rejects_split_request_body(port) |> should.be_true
}

@external(erlang, "herdr_test_ffi", "rejects_split_request_body")
fn rejects_split_request_body(port: Int) -> Bool

fn send(url, method) {
  let assert Ok(req) = request.to(url)
  let assert Ok(res) =
    httpc.configure()
    |> httpc.timeout(2000)
    |> httpc.dispatch(request.set_method(req, method))
  res
}
