import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../../logger";

export type PatchNotesChange = { comment: string; list: string[] };
export type PatchNotesSection = {
    type: string; title: string; description: string;
    background: string; cta: string; url: string; changes: PatchNotesChange[];
};
export type PatchNotesCategory = { type: string; title: string; sections: PatchNotesSection[] };
export type PatchNotesPayload = {
    date: string; description: string; language: string; notes: PatchNotesCategory[];
    permalink: string; release_version: string; title: string;
};

// CL392819's native serializers: payload RVA 0x1AEFBF0, categories
// 0x1AEF830, sections 0x1AEFFE0 and changes 0x1AEF7C0. In particular,
// bullets are changes[].list (strings), not "bullets" or "items".
const DefaultDirectory = resolve(__dirname, "../../../../data/1.12/patchnotes");
const MaximumFileSize = 256 * 1024;
type CachedFile = { signature: string; payload: PatchNotesPayload; rejectedSignature?: string };
const Cache = new Map<string, CachedFile>();

function ObjectValue(Value: unknown): Record<string, unknown> {
    if(Value === null || typeof Value !== "object" || Array.isArray(Value)) throw new Error("Expected an object");
    return Value as Record<string, unknown>;
}
function Text(Value: unknown, Required = false, Limit = 16000): string {
    if(typeof Value !== "string" || Value.length > Limit || (Required && !Value.trim())) throw new Error("Invalid text");
    return Value;
}
function Entries(Value: unknown, Maximum: number, Required = false): unknown[] {
    if(!Array.isArray(Value) || Value.length > Maximum || (Required && Value.length === 0)) throw new Error("Invalid list");
    return Value;
}
function Identifier(Value: unknown): string {
    const Id = Text(Value, true, 64);
    if(!/^[a-z][a-z0-9_-]*$/.test(Id)) throw new Error("Invalid type");
    return Id;
}
function Locale(Value: string): string | undefined {
    const Normalized = Value.toLowerCase().replace(/_/g, "-");
    return /^[a-z]{2}(?:-[a-z]{2})?$/.test(Normalized) ? Normalized : undefined;
}

export function ParsePatchNotes(Value: unknown, ExpectedLanguage?: string): PatchNotesPayload {
    const Root = ObjectValue(Value);
    const Language = Text(Root.language, true, 5);
    if(Locale(Language) !== Language || (ExpectedLanguage && Language !== ExpectedLanguage)) throw new Error("Invalid language");
    const Date = Text(Root.date, true, 40);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(Date) || !Number.isFinite(globalThis.Date.parse(Date))) {
        throw new Error("Invalid date");
    }
    const Types = new Set<string>();
    const Notes = Entries(Root.notes, 20, true).map(Value => {
        const Category = ObjectValue(Value);
        const Type = Identifier(Category.type);
        if(Types.has(Type)) throw new Error("Duplicate category type");
        Types.add(Type);
        const Sections = Entries(Category.sections, 100, true).map(Value => {
            const Section = ObjectValue(Value);
            return {
                type: Identifier(Section.type), title: Text(Section.title, true, 200),
                description: Text(Section.description ?? ""),
                background: Text(Section.background ?? "", false, 2048),
                cta: Text(Section.cta ?? "", false, 200), url: Text(Section.url ?? "", false, 2048),
                changes: Entries(Section.changes ?? [], 100).map(Value => {
                    const Change = ObjectValue(Value);
                    return { comment: Text(Change.comment ?? ""),
                        list: Entries(Change.list ?? [], 100).map(Value => Text(Value, true)) };
                })
            };
        });
        return { type: Type, title: Text(Category.title, true, 100), sections: Sections };
    });
    return { date: Date, description: Text(Root.description ?? ""), language: Language, notes: Notes,
        permalink: Text(Root.permalink ?? "", false, 2048), release_version: Text(Root.release_version, true, 64),
        title: Text(Root.title, true, 200) };
}

function ReadNotes(File: string, Language: string): PatchNotesPayload | undefined {
    let Signature = "unreadable";
    const Previous = Cache.get(File);
    try {
        const Stat = statSync(File);
        Signature = `${Stat.mtimeMs}:${Stat.size}`;
        if(Previous && (Previous.signature === Signature || Previous.rejectedSignature === Signature)) return Previous.payload;
        if(!Stat.isFile() || Stat.size > MaximumFileSize) throw new Error("Invalid patch notes file");
        const Payload = ParsePatchNotes(JSON.parse(readFileSync(File, "utf8")), Language);
        Cache.set(File, { signature: Signature, payload: Payload });
        return Payload;
    } catch(Error) {
        // Missing translations fall back to their base language, then English.
        if((Error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        if(Previous) Previous.rejectedSignature = Signature;
        // Do not log submitted content, parser errors or private file paths.
        logger.warn("Patch notes content is unavailable or invalid; using the last valid content or English fallback");
        return Previous?.payload;
    }
}

const Unavailable: PatchNotesPayload = {
    date: "2026-10-02T00:00:00Z", title: "Undaunted", release_version: "1.12.0", language: "en",
    description: "Community updates", permalink: "",
    notes: [{ type: "information", title: "Server Information", sections: [{
        type: "text", title: "Update notes", description: "Community update notes are temporarily unavailable. Please try again later.",
        background: "", cta: "", url: "", changes: []
    }] }]
};

export function GetPatchNotes(Language: string): PatchNotesPayload {
    const Directory = process.env.PATCH_NOTES_DIR ? resolve(process.env.PATCH_NOTES_DIR) : DefaultDirectory;
    const Requested = Locale(Language);
    const Languages = [...new Set([Requested, Requested?.split("-")[0], "en"].filter((Value): Value is string => !!Value))];
    for(const Candidate of Languages){
        const Payload = ReadNotes(join(Directory, `${Candidate}.json`), Candidate);
        if(Payload) return Payload;
    }
    return Unavailable;
}
