// Public hunting grounds are shared, as in the live game: a party starting one
// where a public world of that island already has room is sent into it.
// Private hunts (the client's Private Hunt button sends isPrivate) always get
// their own world and are never joined. A player's slot is freed when they
// travel anywhere else or go offline (closing the client), so the count is the
// players who are actually there.

// The runtime gives every world MaxPlayers=4 (server/WorldLifecycle.cpp).
export const HUNTING_GROUND_MAX_PLAYERS = 4;

type HuntingGroundWorld = { HuntId: string, Public: boolean, Host: string, Port: number, Players: Set<string> };

const Worlds = new Map<string, HuntingGroundWorld>(); // Key is host:port
const PlayerWorld = new Map<string, string>(); // Key is player id
const PublicAllocations = new Map<string, Promise<void>>(); // Pending allocations by island

const WorldKey = (Host: string, Port: number) => `${Host}:${Port}`;

// Select and record a public world's capacity in one allocation turn. Without
// this, requests arriving while deploy is awaited can each start a world or
// promise the same last slot. Other islands and private hunts remain independent.
export async function AllocatePublicHuntingGround<T>(HuntId: string, Allocate: () => Promise<T>): Promise<T> {
    const Previous = PublicAllocations.get(HuntId) ?? Promise.resolve();
    let Release!: () => void;
    const Completed = new Promise<void>(Resolve => { Release = Resolve; });
    PublicAllocations.set(HuntId, Completed);
    await Previous;
    try {
        return await Allocate();
    } finally {
        Release();
        if(PublicAllocations.get(HuntId) === Completed) PublicAllocations.delete(HuntId);
    }
}

function Forget(Key: string){
    const World = Worlds.get(Key);
    if(World == undefined) return;
    for(const PlayerId of World.Players){
        if(PlayerWorld.get(PlayerId) === Key) PlayerWorld.delete(PlayerId);
    }
    Worlds.delete(Key);
}

export function ReleaseHuntingGroundSlot(PlayerId: string){
    const Key = PlayerWorld.get(PlayerId);
    if(Key == undefined) return;
    PlayerWorld.delete(PlayerId);
    const World = Worlds.get(Key);
    if(World == undefined) return;
    World.Players.delete(PlayerId);
    // An empty world is about to be reaped; nobody is sent to it.
    if(World.Players.size === 0) Worlds.delete(Key);
}

// A public world of this hunt with room for the whole party. The party's own
// members are not counted, so asking for the island you are on keeps your place.
export function FindPublicHuntingGround(HuntId: string, Party: string[]){
    for(const World of Worlds.values()){
        const Others = [...World.Players].filter(PlayerId => !Party.includes(PlayerId)).length;
        if(World.Public && World.HuntId === HuntId && World.Players.size > 0
            && Others + Party.length <= HUNTING_GROUND_MAX_PLAYERS){
            return { Host: World.Host, Port: World.Port };
        }
    }
    return undefined;
}

// A world the deploy server answered for: a new one (whatever was recorded on
// that address before has ended), or the running world the players joined.
export function RecordHuntingGround(HuntId: string, Public: boolean, Host: string, Port: number, Players: string[], NewWorld: boolean){
    const Key = WorldKey(Host, Port);
    if(NewWorld) Forget(Key);
    let World = Worlds.get(Key);
    if(World == undefined){
        World = { HuntId, Public, Host, Port, Players: new Set<string>() };
        Worlds.set(Key, World);
    }
    for(const PlayerId of Players){
        if(PlayerWorld.get(PlayerId) !== Key) ReleaseHuntingGroundSlot(PlayerId);
        World.Players.add(PlayerId);
        PlayerWorld.set(PlayerId, Key);
    }
}

// The deploy server found the world gone (or reused) when asked to join it.
export function ForgetHuntingGround(Host: string, Port: number){
    Forget(WorldKey(Host, Port));
}

export function HuntingGroundPlayers(Host: string, Port: number){
    return [...(Worlds.get(WorldKey(Host, Port))?.Players ?? [])];
}
