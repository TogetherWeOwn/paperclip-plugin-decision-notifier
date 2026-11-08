import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const MAX_RECORDS = 10_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

/** A capped delivery ledger, never an acknowledgement or a complete pending set. */
export function deliveryState(file, scope) {
  const records = new Map();
  const legacy = new Set();
  if (file && existsSync(file)) {
    if (statSync(file).size > 4 * 1024 * 1024) throw new Error("seen ledger exceeds 4 MiB");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record?.version === 1 && typeof record.scope === "string" && typeof record.key === "string" &&
            Number.isFinite(record.deliveredAt) && record.deliveredAt >= 0) {
          records.set(JSON.stringify([record.scope, record.key]), record);
        }
      } catch {
        // Old plugin ledgers had no delivery timestamp. They must not suppress forever.
        if (/^(interaction|approval|owner_card|run_failure):/.test(line)) legacy.add(line);
      }
    }
  }
  const recordKey = (key) => JSON.stringify([scope, key]);
  return {
    previous(key) {
      const record = records.get(recordKey(key));
      return record?.deliveredAt ?? (legacy.has(key) ? 0 : null);
    },
    delivered(key, now) {
      records.set(recordKey(key), { version: 1, scope, key, deliveredAt: now });
      if (!file) return;
      // Desk snapshots can be capped/collapsed. Absence is NOT proof of resolution.
      for (const oldKey of legacy) {
        if (!records.has(recordKey(oldKey))) records.set(recordKey(oldKey), { version: 1, scope, key: oldKey, deliveredAt: 0 });
      }
      const kept = [...records.values()]
        .filter((record) => record.deliveredAt === 0 || record.deliveredAt >= now - RETENTION_MS)
        .sort((a, b) => b.deliveredAt - a.deliveredAt).slice(0, MAX_RECORDS);
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, kept.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
