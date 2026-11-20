-module(herdr_web_runtime).
-export([env/1, asset/1]).

env(Name) ->
    case os:getenv(binary_to_list(Name)) of
        false -> {error, nil};
        Value -> {ok, unicode:characters_to_binary(Value)}
    end.

asset(Name) ->
    case file:read_file(filename:join([code:priv_dir(herdr_web), "static", Name])) of
        {ok, Bytes} -> {ok, Bytes};
        _ -> {error, nil}
    end.
