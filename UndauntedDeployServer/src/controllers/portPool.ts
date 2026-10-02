// Island ports. A port is either free or held by one world. The exit handler
// and a failed startup can both see the same world end; releasing twice used
// to put the port on the free list twice, so the next two islands shared it.
export class PortPool {
    private readonly Free: number[] = [];
    private readonly Held = new Set<number>();

    add(Port: number): void {
        if (!this.Held.has(Port) && !this.Free.includes(Port)) this.Free.push(Port);
    }

    take(): number | undefined {
        const Port = this.Free.pop();
        if (Port !== undefined) this.Held.add(Port);
        return Port;
    }

    // Returns false when the port was not held, e.g. already released.
    release(Port: number): boolean {
        if (!this.Held.delete(Port)) return false;
        this.Free.push(Port);
        return true;
    }

    get freeCount(): number {
        return this.Free.length;
    }
}
