%% Long-lived CLI transport. erlexec owns/reaps the OS child even if this worker
%% is killed. Arguments go directly to execve, never through a shell.
-module(herdr_web_process).
-behaviour(gen_server).
-export([start/4, start_link/4, demand/1, write/2, stop/1, os_pid/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2]).
-define(LIMIT, 1048576).

start(Executable, Args, Owner, Notify) ->
    case supervisor:start_child(herdr_web_process_sup, [Executable, Args, Owner, Notify]) of
        {ok, Pid} -> {ok, Pid};
        {error, _} -> {error, <<"process_start_failed">>}
    end.

start_link(Executable, Args, Owner, Notify) ->
    gen_server:start_link(?MODULE, {Executable, Args, Owner, Notify}, []).

demand(Pid) -> gen_server:cast(Pid, demand), nil.
stop(Pid) ->
    try gen_server:stop(Pid, normal, 3000) catch exit:_ -> ok end,
    nil.
os_pid(Pid) -> gen_server:call(Pid, os_pid).
write(Pid, Data) when byte_size(Data) =< 65536 ->
    try gen_server:call(Pid, {write, Data}, 1000)
    catch exit:_ -> {error, <<"process_unavailable">>} end;
write(_, _) -> {error, <<"input_too_large">>}.

init({Executable, Args, Owner, Notify}) ->
    process_flag(trap_exit, true),
    process_flag(max_heap_size, #{size => 2000000, kill => true, error_logger => false}),
    Ref = monitor(process, Owner),
    Worker = self(),
    Output = fun(Stream, OsPid, Data) ->
        case process_info(Worker, message_queue_len) of
            {message_queue_len, N} when N < 16 -> Worker ! {Stream, OsPid, Data};
            _ -> Worker ! overflow, exit(normal)
        end
    end,
    case os:find_executable(binary_to_list(Executable)) of
        false -> {stop, executable_not_found};
        Path ->
            case exec:run_link([unicode:characters_to_binary(Path) | Args],
                    [stdin, {stdout, Output}, {stderr, Output}, {kill_timeout, 1},
                     {group, 0}, kill_group]) of
                {ok, Proxy, OsPid} ->
                    {ok, #{proxy => Proxy, os_pid => OsPid, owner => Ref,
                        notify => Notify, queue => queue:new(), bytes => 0,
                        fragment => <<>>, credit => false, status => pending, input_bytes => 0,
                        stderr => <<>>}};
                {error, _} -> {stop, spawn_failed}
            end
    end.

handle_call(os_pid, _, S) -> {reply, maps:get(os_pid, S), S};
handle_call({write, Data}, _, #{input_bytes := Size, notify := Notify} = S)
        when Size + byte_size(Data) > ?LIMIT ->
    Notify({failed, <<"input_limit">>}),
    {stop, normal, {error, <<"input_limit">>}, S};
handle_call({write, Data}, _, #{proxy := Proxy, status := pending} = S) ->
    Reply = try exec:send(Proxy, Data) of
        ok -> {ok, nil};
        {error, _} -> {error, <<"process_unavailable">>}
    catch _:_ -> {error, <<"process_unavailable">>} end,
    {reply, Reply, S#{input_bytes => maps:get(input_bytes, S) + byte_size(Data)}};
handle_call({write, _}, _, S) -> {reply, {error, <<"process_unavailable">>}, S}.

handle_cast(demand, S) -> deliver(S#{credit => true}).

handle_info({stdout, OsPid, Data}, #{os_pid := OsPid, fragment := Fragment, bytes := Size} = S) ->
    case Size + byte_size(Data) > ?LIMIT of
        true -> fail(<<"output_overflow">>, S);
        false ->
            Parts = binary:split(<<Fragment/binary, Data/binary>>, <<"\n">>, [global]),
            [Rest | ReverseLines] = lists:reverse(Parts),
            case length(ReverseLines) + queue:len(maps:get(queue, S)) > 128 of
                true -> fail(<<"output_overflow">>, S);
                false ->
                    Q = lists:foldl(fun(Line, Queue) -> queue:in(Line, Queue) end,
                        maps:get(queue, S), lists:reverse(ReverseLines)),
                    deliver(S#{queue => Q, fragment => Rest, bytes => Size + byte_size(Data)})
            end
    end;
handle_info({stderr, OsPid, Data}, #{os_pid := OsPid, stderr := Existing} = S) ->
    Combined = <<Existing/binary, Data/binary>>,
    Kept = binary:part(Combined, 0, min(byte_size(Combined), 4096)),
    {noreply, S#{stderr => Kept}};
handle_info({'DOWN', Ref, process, _, _}, #{owner := Ref} = S) -> {stop, normal, S};
handle_info({'DOWN', OsPid, process, Proxy, Reason}, #{os_pid := OsPid, proxy := Proxy} = S) ->
    deliver(S#{status => exit_code(Reason)});
handle_info({'EXIT', Proxy, Reason}, #{proxy := Proxy} = S) ->
    deliver(S#{status => exit_code(Reason)});
handle_info(overflow, S) -> fail(<<"output_overflow">>, S);
handle_info(_, S) -> {noreply, S}.

deliver(#{queue := Q, credit := Credit, notify := Notify, bytes := Size} = S) ->
    case {Credit, queue:out(Q)} of
        {true, {{value, Line}, Remaining}} ->
            case unicode:characters_to_binary(Line) of
                Line ->
                    Notify({line, Line}),
                    finish(S#{queue => Remaining, credit => false, bytes => Size - byte_size(Line) - 1});
                _ -> fail(<<"invalid_utf8">>, S)
            end;
        _ -> finish(S)
    end.

finish(#{status := pending} = S) -> {noreply, S};
finish(#{queue := Q, fragment := Fragment, status := Code, notify := Notify, stderr := Err} = S) ->
    case queue:is_empty(Q) of
        false -> {noreply, S};
        true when Fragment =/= <<>> -> fail(<<"truncated_record">>, S);
        true -> Notify({exited, Code, Err}), {stop, normal, S}
    end.

fail(Reason, #{notify := Notify} = S) ->
    Notify({failed, Reason}),
    {stop, normal, S}.

exit_code(normal) -> 0;
exit_code({exit_status, Status}) -> status_code(Status);
exit_code({status, Status}) -> status_code(Status);
exit_code(_) -> 1.
status_code(Status) ->
    case exec:status(Status) of {status, Code} -> Code; _ -> 1 end.

terminate(_, #{proxy := Proxy, status := pending}) ->
    Ref = monitor(process, Proxy),
    try exec:stop(Proxy) catch _:_ -> ok end,
    receive {'DOWN', Ref, process, Proxy, _} -> ok
    after 2000 -> demonitor(Ref, [flush]) end,
    ok;
terminate(_, _) -> ok.
