// Read at startup, after the process has loaded its environment file.
export function HttpListenerConfig(): Readonly<{ host: string; port: number }> {
    const port = Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return { host: process.env.HOST || "127.0.0.1", port };
}

export function DatabaseFilename(): string {
    if (!process.env.DB_FILENAME) throw new Error("DB_FILENAME must be configured before startup");
    return process.env.DB_FILENAME;
}
