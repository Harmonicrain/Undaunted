// Extra switches for every world server, from GAMESERVER_EXTRA_ARGS, separated
// by whitespace (for example "-UndauntedServerFPS=60"). Each becomes its own
// argument; no shell is involved.
export function ParseExtraWorldArgs(Value: string | undefined): string[] {
    return (Value ?? "").split(/\s+/).filter(Arg => Arg.length > 0);
}
