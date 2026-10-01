import { closeSync, ftruncateSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// Must match server/TrainingLifecycle.cpp. Other exits retain crash recovery.
export const TRAINING_IDLE_EXIT_CODE = 75;
export const TRAINING_IDLE_SECONDS = 300;
export const TRAINING_TRAVEL_RESERVATION_MS = 120_000;

export function TrainingLeasePath(Binary: string, ProcessId: number): string {
    return join(dirname(Binary), `undaunted-training-${ProcessId}.lease`);
}

export function CreateTrainingLease(Path: string, Now = Date.now()): void {
    writeFileSync(Path, String(Now + TRAINING_TRAVEL_RESERVATION_MS));
}

export function ReserveTrainingLease(Path: string, Now = Date.now()): boolean {
    let File: number;
    try { File = openSync(Path, "r+"); }
    catch (Error) {
        // The native game thread holds an exclusive Windows handle while deciding
        // to sleep. Wait for it to exit rather than return a dying world's port.
        if (["EACCES", "EPERM", "EBUSY", "ENOENT"].includes((Error as NodeJS.ErrnoException).code ?? "")) return false;
        throw Error;
    }
    try {
        const Previous = readFileSync(File, "utf8").trim();
        if (!/^\d{13,16}$/.test(Previous)) return false;
        const Expiry = Math.max(Number(Previous), Now + TRAINING_TRAVEL_RESERVATION_MS);
        const Bytes = Buffer.from(String(Expiry).padEnd(16, " "));
        // Keep fixed length so there are no trailing digits from the old value.
        writeSync(File, Bytes, 0, Bytes.length, 0);
        ftruncateSync(File, Bytes.length);
        fsyncSync(File);
        return true;
    } finally { closeSync(File); }
}

export function RemoveTrainingLease(Path: string): void {
    try { unlinkSync(Path); }
    catch (Error) { if ((Error as NodeJS.ErrnoException).code !== "ENOENT") throw Error; }
}

export function TrainingSleepMarked(Path: string): boolean {
    try { return readFileSync(Path, "utf8").trim() === "sleeping"; }
    catch (Error) {
        if (["ENOENT", "EACCES", "EPERM", "EBUSY"].includes((Error as NodeJS.ErrnoException).code ?? "")) return false;
        throw Error;
    }
}
