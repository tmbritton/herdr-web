-module(herdr_test_ffi).
-export([rejects_split_request_body/1, owner_death_cleans_child/0]).
-export([non_reader_input_is_bounded/0, cleanup_is_prompt/0, exit_write_race/0]).

non_reader_input_is_bounded() ->
    {ok, Worker} = herdr_web_process:start(<<"/bin/sleep">>, [<<"30">>], self(), fun(_) -> nil end),
    try
        Chunk = binary:copy(<<"x">>, 65536),
        Results = [herdr_web_process:write(Worker, Chunk) || _ <- lists:seq(1, 20)],
        lists:any(fun(R) -> R =:= {error, <<"input_limit">>} end, Results)
    after herdr_web_process:stop(Worker) end.

cleanup_is_prompt() ->
    Parent = self(),
    {ok, Worker} = herdr_web_process:start(<<"/bin/cat">>, [], self(), fun(E) -> Parent ! {ready, E} end),
    herdr_web_process:write(Worker, <<"ready\n">>),
    herdr_web_process:demand(Worker),
    receive {ready, {line, <<"ready">>}} -> ok after 2000 -> error(not_ready) end,
    Start = erlang:monotonic_time(millisecond),
    herdr_web_process:stop(Worker),
    erlang:monotonic_time(millisecond) - Start < 1000.

exit_write_race() ->
    Parent = self(),
    {ok, Worker} = herdr_web_process:start(<<"/bin/sleep">>, [<<"30">>], self(), fun(E) -> Parent ! {event, E} end),
    OsPid = herdr_web_process:os_pid(Worker),
    Proxy = exec:pid(OsPid),
    erlang:suspend_process(Proxy),
    try
        exec:kill(Proxy, sigkill),
        wait_until_unmanaged(OsPid, 100),
        Result = herdr_web_process:write(Worker, <<"input">>),
        Alive = is_process_alive(Worker),
        erlang:resume_process(Proxy),
        Result =:= {error, <<"process_unavailable">>} andalso Alive andalso
            receive {event, {exited, _, _}} -> true after 2000 -> false end
    after
        try erlang:resume_process(Proxy) catch error:badarg -> ok end,
        herdr_web_process:stop(Worker)
    end.

wait_until_unmanaged(_, 0) -> error(child_did_not_exit);
wait_until_unmanaged(OsPid, N) ->
    case exec:pid(OsPid) of
        undefined -> ok;
        _ -> timer:sleep(10), wait_until_unmanaged(OsPid, N - 1)
    end.

owner_death_cleans_child() ->
    Parent = self(),
    Owner = spawn(fun() ->
        {ok, Worker} = herdr_web_process:start(<<"/bin/cat">>, [], self(), fun(_) -> nil end),
        Parent ! {child, Worker, herdr_web_process:os_pid(Worker)},
        receive stop -> ok end
    end),
    receive {child, Worker, OsPid} ->
        Ref = monitor(process, Worker),
        exit(Owner, kill),
        receive {'DOWN', Ref, process, Worker, _} ->
            not lists:member(OsPid, exec:which_children())
        after 3000 -> false end
    after 3000 -> exit(Owner, kill), false end.

rejects_split_request_body(Port) ->
    {ok, Socket} = gen_tcp:connect({127,0,0,1}, Port, [binary, {active, false}], 2000),
    Body = <<"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n">>,
    try
        ok = gen_tcp:send(Socket, [
            "POST /healthz HTTP/1.1\r\nHost: localhost\r\nContent-Length: ",
            integer_to_list(byte_size(Body)), "\r\n\r\n"
        ]),
        {ok, _Response} = gen_tcp:recv(Socket, 0, 2000),
        _ = gen_tcp:send(Socket, Body),
        gen_tcp:recv(Socket, 0, 2000) =:= {error, closed}
    after
        gen_tcp:close(Socket)
    end.
