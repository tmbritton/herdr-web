import gleeunit/should
import herdr_web/history

pub fn reported_opencode_session_only_test() {
  history.reference(
    "{\"result\":{\"pane\":{\"agent_session\":{\"agent\":\"opencode\",\"kind\":\"id\",\"value\":\"ses_abc123\"}}}}",
  )
  |> should.equal(Ok("ses_abc123"))
  history.reference(
    "{\"result\":{\"pane\":{\"agent_session\":{\"agent\":\"claude\",\"kind\":\"id\",\"value\":\"ses_abc123\"}}}}",
  )
  |> should.be_error
  history.reference("{\"result\":{\"pane\":{\"agent_session\":null}}}")
  |> should.be_error
  history.valid_session("ses_x'; DELETE FROM session;--") |> should.be_false
  history.valid_session("ses_") |> should.be_false
}

pub fn bounded_history_page_request_test() {
  history.page_start("latest") |> should.equal(Ok(-1))
  history.page_start("0") |> should.equal(Ok(0))
  history.page_start("1600") |> should.equal(Ok(1600))
  history.page_start("-1") |> should.be_error
  history.page_start("1; select 1") |> should.be_error
  history.page_start("99999999999999999999") |> should.be_error
}
