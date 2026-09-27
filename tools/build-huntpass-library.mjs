// Build selector metadata from locally exported 1.12 data. Does not alter
// progression rewards or overwrite the store. Game-derived inputs/output
// belong outside the repository. Usage: node tools/build-huntpass-library.mjs
// <progression.json> <huntpass-season-table.jsonl> <catalog.jsonl> <output.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [progressionFile, tableFile, catalogFile, outputFile] = process.argv.slice(2);
if(!outputFile) throw new Error('Expected progression, season table, item catalogue and output paths');
const paths = JSON.parse(readFileSync(progressionFile, 'utf8'));
const lines = file => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const rows = lines(tableFile), catalog = new Set(lines(catalogFile).map(item => item.itemId.toUpperCase()));
const entries = [];
for(const path of paths){
    const trackId = path.progression_id;
    if(!/^season\d+[a-c]?(_vault)?$/.test(trackId)) continue;
    // Exact canonical row avoids the shipped Season07b_vault alias of 07a.
    const rowName = `HuntPass_Season${trackId.slice('season'.length)}`;
    const row = rows.find(row => row.rowName === rowName && row.base.progressionTrack === trackId);
    if(!row) throw new Error(`No canonical client row for ${trackId}`);
    if(!path.requirements?.length || !Number.isFinite(Date.parse(path.start_date)) ||
        path.premium_gating_entitlement !== `${trackId}_premium`) throw new Error(`Incomplete track ${trackId}`);
    for(const reward of [...(path.free_rewards ?? []), ...(path.premium_rewards ?? []), path.prestige?.free_rewards, path.prestige?.premium_rewards].filter(Boolean)){
        const items = [...(reward.stacked_items ?? []), ...(reward.instanced_items ?? []), ...(reward.ordered_instanced_items ?? [])];
        for(const item of items){
            const id = typeof item === 'string' ? item : item.catalog_id;
            if(!catalog.has(id.toUpperCase())) throw new Error(`${trackId} references missing item ${id}`);
        }
    }
    entries.push({ trackId, rowName, sku: `${trackId}_premium`, storeTag: `${trackId}_pass`,
        entitlement: path.premium_gating_entitlement, title: row.seasonTitle || `Hunt Pass ${trackId.slice(6).replace('_vault', ' (Vault)')}` });
}
writeFileSync(outputFile, JSON.stringify(entries, null, 2) + '\n');
console.log(`Validated ${entries.length} regular/vault passes; wrote ${outputFile}. Event passes are unchanged.`);
