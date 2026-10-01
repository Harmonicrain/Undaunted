// A running hunt the metagame wants more players sent to (a public hunting
// ground with room). It must still be running and still be that hunt: a port
// is reused once its world ends, so the caller starts a new world otherwise.
export type JoinableWorld = {
    port: number,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    processId: number,
    expectedPlayers: { playerHuntId: string }[] | undefined
};

export function FindJoinableWorld<T extends JoinableWorld>(Worlds: T[], Port: unknown, HuntId: string, IsAlive: (ProcessId: number) => boolean): T | undefined {
    if(!Number.isInteger(Port)) return undefined;
    return Worlds.find(World => World.port === Port && !World.isRamsgate && !World.isTrainingDojo
        && World.expectedPlayers?.some(Player => Player.playerHuntId === HuntId) === true
        && IsAlive(World.processId));
}
