-module(herdr_test_ffi).
-export([rejects_split_request_body/1]).

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
