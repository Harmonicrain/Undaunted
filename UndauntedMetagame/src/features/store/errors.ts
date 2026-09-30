export class StoreError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
