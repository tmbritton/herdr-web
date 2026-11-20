-module(herdr_web_process_sup).
-behaviour(supervisor).
-export([start/0, init/1]).

start() ->
    case supervisor:start_link({local, ?MODULE}, ?MODULE, []) of
        {ok, Pid} -> {ok, Pid};
        {error, Reason} -> {error, iolist_to_binary(io_lib:format("~p", [Reason]))}
    end.

init([]) ->
    Child = #{id => attachment, start => {herdr_web_process, start_link, []},
        restart => temporary, shutdown => 3000, type => worker},
    {ok, {#{strategy => simple_one_for_one, intensity => 5, period => 10}, [Child]}}.
