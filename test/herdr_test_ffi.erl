-module(herdr_test_ffi).
-export([rejects_split_request_body/1, owner_death_cleans_child/0]).
-export([non_reader_input_is_bounded/0, cleanup_is_prompt/0, exit_write_race/0]).
-export([socket_deadline/4]).

socket_deadline(Port, Ack, Control, Reason) ->
    {ok, Socket} = gen_tcp:connect({127,0,0,1}, Port, [binary, {active, false}], 2000),
    try
        ok = gen_tcp:send(Socket, <<"GET /ws/w1:p1 HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: http://127.0.0.1:3000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n">>),
        {Headers, Rest} = receive_headers(Socket, <<>>),
        <<"HTTP/1.1 101", _/binary>> = Headers,
        Pending = case Ack of
            true ->
                AfterFirst = await_binary(Socket, Rest),
                ws_text(Socket, <<"{\"type\":\"ack\",\"generation\":1,\"seq\":1}">>),
                case Control of
                    true ->
                        ws_text(Socket, <<"{\"type\":\"control\",\"generation\":1,\"takeover\":false}">>),
                        AfterControl = await_binary(Socket, AfterFirst),
                        ws_text(Socket, <<"{\"type\":\"ack\",\"generation\":2,\"seq\":1}">>),
                        AfterControl;
                    false -> AfterFirst
                end;
            false -> Rest
        end,
        Output = receive_closed(Socket, Pending),
        binary:match(Output, Reason) =/= nomatch
    after gen_tcp:close(Socket) end.

receive_headers(Socket, Buffer) when byte_size(Buffer) < 16384 ->
    case binary:split(Buffer, <<"\r\n\r\n">>) of
        [Headers, Rest] -> {Headers, Rest};
        [_] -> {ok, Bytes} = gen_tcp:recv(Socket, 0, 2500), receive_headers(Socket, <<Buffer/binary, Bytes/binary>>)
    end.

receive_closed(Socket, Buffer) when byte_size(Buffer) < 16384 ->
    case gen_tcp:recv(Socket, 0, 2500) of
        {ok, Bytes} -> receive_closed(Socket, <<Buffer/binary, Bytes/binary>>);
        {error, closed} -> Buffer;
        _ -> <<>>
    end.

await_binary(Socket, Buffer) ->
    case ws_frame(Buffer) of
        more -> {ok, Bytes} = gen_tcp:recv(Socket, 0, 2500), await_binary(Socket, <<Buffer/binary, Bytes/binary>>);
        {2, _, Rest} -> Rest;
        {_, _, Rest} -> await_binary(Socket, Rest)
    end.

ws_frame(<<_:4, Opcode:4, 0:1, Size:7, Payload:Size/binary, Rest/binary>>) when Size < 126 -> {Opcode, Payload, Rest};
ws_frame(<<_:4, Opcode:4, 0:1, 126:7, Size:16, Payload:Size/binary, Rest/binary>>) -> {Opcode, Payload, Rest};
ws_frame(_) -> more.

ws_text(Socket, Text) when byte_size(Text) < 126 ->
    Mask = <<1,2,3,4>>,
    Encoded = list_to_binary([B bxor binary:at(Mask, I rem 4) || {B, I} <- lists:zip(binary_to_list(Text), lists:seq(0, byte_size(Text) - 1))]),
    gen_tcp:send(Socket, <<16#81, 1:1, (byte_size(Text)):7, Mask/binary, Encoded/binary>>).

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
