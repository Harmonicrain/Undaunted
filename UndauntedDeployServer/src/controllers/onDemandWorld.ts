// Coalesce travel requests, including requests arriving while an idle world exits.
export class OnDemandWorld<T> {
    private Current: T | undefined;
    private Pending: Promise<T> | undefined;

    constructor(private readonly Options: {
        start: () => Promise<T>;
        alive: (World: T) => boolean;
        reserve: (World: T) => boolean;
        wait: () => Promise<void>;
        now: () => number;
    }) {}

    get(): Promise<T> {
        if (!this.Pending) {
            this.Pending = this.acquire().finally(() => { this.Pending = undefined; });
        }
        return this.Pending;
    }

    forget(World: T): void {
        if (this.Current === World) this.Current = undefined;
    }

    private async acquire(): Promise<T> {
        const Deadline = this.Options.now() + 10_000;
        for (;;) {
            if (!this.Current || !this.Options.alive(this.Current)) {
                this.Current = await this.Options.start();
            }
            if (this.Options.reserve(this.Current) && this.Options.alive(this.Current)) return this.Current;
            if (this.Options.now() >= Deadline) throw new Error("Training Grounds did not accept a travel reservation");
            await this.Options.wait();
        }
    }
}
