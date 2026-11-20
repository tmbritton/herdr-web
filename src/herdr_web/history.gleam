import gleam/dynamic/decode as d
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import gleam/string
import herdr_web/config.{type Config}
import herdr_web/subprocess

pub fn valid_session(value: String) -> Bool {
  string.starts_with(value, "ses_")
  && string.length(value) > 4
  && string.length(value) <= 132
  && value
  |> string.to_graphemes
  |> list.all(fn(char) {
    string.contains(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
      char,
    )
  })
}

pub fn reference(body: String) -> Result(String, Nil) {
  let decoder = {
    use agent <- d.then(d.at(
      ["result", "pane", "agent_session", "agent"],
      d.string,
    ))
    use kind <- d.then(d.at(
      ["result", "pane", "agent_session", "kind"],
      d.string,
    ))
    use id <- d.then(d.at(
      ["result", "pane", "agent_session", "value"],
      d.string,
    ))
    d.success(#(agent, kind, id))
  }
  case json.parse(body, decoder) {
    Ok(#("opencode", "id", id)) ->
      case valid_session(id) {
        True -> Ok(id)
        False -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

pub fn page_start(value: String) -> Result(Int, Nil) {
  case value, int.parse(value) {
    "latest", _ -> Ok(-1)
    _, Ok(n) if n >= 0 && n <= 1_000_000_000 -> Ok(n)
    _, _ -> Error(Nil)
  }
}

// Only a validated Herdr-reported identity can select a transcript. The expected
// identity pins subsequent pages, so changing sessions in the TUI cannot mix them.
pub fn read_page(
  cfg: Config,
  pane: String,
  start: Int,
  expected: String,
) -> Result(String, #(Int, String)) {
  use metadata <- result.try(
    subprocess.run(
      cfg.executable,
      list.append(cfg.prefix, ["pane", "get", pane]),
    )
    |> result.replace_error(#(503, "Herdr pane lookup unavailable")),
  )
  use session <- result.try(
    reference(metadata)
    |> result.replace_error(#(404, "This pane has no reported OpenCode session")),
  )
  case expected != "" && expected != session {
    True ->
      Error(#(409, "OpenCode session changed; reload History to follow it"))
    False -> {
      use body <- result.try(
        subprocess.run(cfg.sqlite, [
          "-readonly",
          "-batch",
          "-init",
          "/dev/null",
          cfg.history_database,
          query(session, start),
        ])
        |> result.replace_error(#(
          503,
          "History unavailable: check the OpenCode database and sqlite3",
        )),
      )
      case body {
        "null" ->
          Error(#(404, "The reported session is not in this OpenCode database"))
        _ -> Ok(body)
      }
    }
  }
}

fn query(session: String, start: Int) -> String {
  // Fixed SQL, numeric position, validated ID; no user-supplied SQL or DB path.
  // Work out chunk ranges without expanding the entire transcript into chunks.
  // Sixteen 4096-byte segments, with up to three overlap bytes to finish UTF-8
  // characters. BLOB length/substr preserve embedded NUL; hex keeps JSON valid.
  let position = case start {
    -1 -> "max(0, total - 16)"
    _ -> "min(" <> int.to_string(start) <> ", max(0, total - 1))"
  }
  "WITH RECURSIVE
source AS (
  SELECT m.time_created AS created, m.id AS message, p.id AS part,
    coalesce(json_extract(m.data, '$.role'), 'unknown') AS role,
    json_extract(p.data, '$.type') AS kind,
    CASE json_extract(p.data, '$.type')
      WHEN 'text' THEN coalesce(json_extract(p.data, '$.text'), '')
      WHEN 'reasoning' THEN coalesce(json_extract(p.data, '$.text'), '')
      WHEN 'tool' THEN coalesce(json_extract(p.data, '$.tool'), 'tool') || char(10)
        || 'Input: ' || coalesce(json_extract(p.data, '$.state.input'), '') || char(10)
        || 'Output: ' || coalesce(json_extract(p.data, '$.state.output'), json_extract(p.data, '$.state.metadata.output'), '')
        || CASE WHEN json_extract(p.data, '$.state.error') IS NOT NULL
          THEN char(10) || 'Error: ' || json_extract(p.data, '$.state.error') ELSE '' END
      WHEN 'file' THEN 'File: ' || coalesce(json_extract(p.data, '$.filename'), json_extract(p.data, '$.mime'), 'attachment')
      WHEN 'compaction' THEN '[Context compaction]'
    END AS text
  FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
  WHERE m.session_id = '" <> session <> "'
), sized AS (
  SELECT *, cast(text AS BLOB) AS payload, (length(cast(text AS BLOB)) + 4095) / 4096 AS units
  FROM source WHERE length(cast(text AS BLOB)) > 0
), ranges AS (
  SELECT *, sum(units) OVER (ORDER BY created, message, part ROWS UNBOUNDED PRECEDING) - units AS base FROM sized
), totals AS (
  SELECT coalesce(sum(units), 0) AS total FROM sized
), bounds AS (
  SELECT total, " <> position <> " AS first FROM totals
), numbers(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM numbers WHERE n < 15),
page AS (
  SELECT message, role, kind, (first+n-base)*4096 AS offset,
    hex(substr(payload, (first+n-base)*4096+1, 4099)) AS bytes
  FROM ranges, bounds, numbers
  WHERE first+n >= base AND first+n < base+units
  ORDER BY first+n
)
SELECT coalesce((SELECT json_object(
  'session', id, 'title', substr(title, 1, 4096), 'start', first, 'total', total,
  'entries', json((SELECT json_group_array(json_object(
    'message', message, 'role', role, 'kind', kind, 'offset', offset, 'bytes', bytes
  )) FROM page))
) FROM session, bounds WHERE id = '" <> session <> "'), 'null');"
}
