"use strict";
// Text chat rooms (XEP-0045 subset). Before these, the server parsed room
// joins and groupchat messages but nothing handled them: the client never saw
// its own room presence, kept the join pending and refused to send
// ("Unable to send message").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Rooms = require("../dist/realtime/RoomService");

const ROOM = "City-7a35f5e9-4b03-4210-84ef-e5e17d9121af@muc.prod.ol.epicgames.com";
let Seq = 0;
function Conn(AccountId, Name){
    const Resource = `V2:Jackal:WIN::${++Seq}`;
    const C = { connId: `test_${Seq}`, accountId: AccountId, resource: Resource, frames: [], send(F){ this.frames.push(F); }, close(){} };
    C.nick = `${Name}:${AccountId}:${Resource}`;
    return C;
}

test("joining returns the joiner's own presence (status 110) after everyone already present", () => {
    const John = Conn("UID-john", "John"), Todd = Conn("UID-todd", "Todd");
    Rooms.JoinRoom(John, John.accountId, John.resource, `${ROOM}/${John.nick}`);
    Rooms.JoinRoom(Todd, Todd.accountId, Todd.resource, `${ROOM}/${Todd.nick}`);

    const ToddPresences = Todd.frames.filter(F => F.startsWith("<presence"));
    assert.equal(ToddPresences.length, 2);
    assert.match(ToddPresences[0], /from="City-[^"]+\/John:UID-john/);
    assert.match(ToddPresences[1], /from="City-[^"]+\/Todd:UID-todd[^"]*"[^>]*><x [^>]*muc#user"><item [^>]*role="participant"[^>]*\/><status code="110"\/>/);
    assert.ok(John.frames.some(F => /from="City-[^"]+\/Todd:UID-todd/.test(F) && !F.includes('code="110"')), "John is told Todd joined");
    Rooms.LeaveAllRooms(John); Rooms.LeaveAllRooms(Todd);
});

test("a groupchat message reaches every occupant, sender included, and only occupants can speak", () => {
    const John = Conn("UID-john", "John"), Todd = Conn("UID-todd", "Todd"), Outsider = Conn("UID-out", "Out");
    Rooms.JoinRoom(John, John.accountId, John.resource, `${ROOM}/${John.nick}`);
    Rooms.JoinRoom(Todd, Todd.accountId, Todd.resource, `${ROOM}/${Todd.nick}`);

    assert.equal(Rooms.SendGroupchat(John, ROOM, "m1", "hello <Todd> & co"), true);
    for(const C of [John, Todd]){
        const Msg = C.frames.find(F => F.includes('id="m1"'));
        assert.ok(Msg, `${C.accountId} received the message`);
        assert.match(Msg, /type="groupchat"/);
        assert.match(Msg, /from="City-[^"]+\/John:UID-john/);
        assert.match(Msg, /<body>hello &lt;Todd&gt; &amp; co<\/body>/);
    }
    assert.equal(Rooms.SendGroupchat(Outsider, ROOM, "m2", "sneaky"), false);
    assert.ok(!Todd.frames.some(F => F.includes('id="m2"')));
    Rooms.LeaveAllRooms(John); Rooms.LeaveAllRooms(Todd);
});

test("leaving, or disconnecting, tells the room and empties it", () => {
    const John = Conn("UID-john", "John"), Todd = Conn("UID-todd", "Todd");
    Rooms.JoinRoom(John, John.accountId, John.resource, `${ROOM}/${John.nick}`);
    Rooms.JoinRoom(Todd, Todd.accountId, Todd.resource, `${ROOM}/${Todd.nick}`);
    Rooms.LeaveAllRooms(John);
    assert.ok(Todd.frames.some(F => F.includes('type="unavailable"') && /from="City-[^"]+\/John:UID-john/.test(F)));
    assert.equal(Rooms.RoomOccupantCount(ROOM), 1);
    Rooms.LeaveRoom(Todd, ROOM);
    assert.equal(Rooms.RoomOccupantCount(ROOM), 0);
});

test("a nick naming another account is refused", () => {
    const Imposter = Conn("UID-eve", "Eve");
    Rooms.JoinRoom(Imposter, Imposter.accountId, Imposter.resource, `${ROOM}/John:UID-john:x`);
    assert.equal(Rooms.RoomOccupantCount(ROOM), 0);
    assert.match(Imposter.frames[0], /type="error"/);
});
