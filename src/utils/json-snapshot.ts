import fs from 'fs';
import { once } from 'events';
import { finished } from 'stream/promises';
import { iterateRows } from './batched-rows';

type SnapshotTable = { model: any; args?: any; batchSize?: number };
let snapshotInProgress = false;

/** Write the existing JSON backup format one row at a time, respecting backpressure. */
export async function writeJsonSnapshot(filePath: string, metadata: Record<string, any>, tables: Record<string, SnapshotTable>) {
  if (snapshotInProgress) throw new Error('توجد نسخة احتياطية قيد الإنشاء، حاول بعد اكتمالها.');
  snapshotInProgress = true;
  const partialPath = filePath + '.partial';
  const output = fs.createWriteStream(partialPath, { flags: 'wx', highWaterMark: 64 * 1024 });
  let ownsPartial = false;
  output.once('open', () => { ownsPartial = true; });
  const completion = finished(output);
  completion.catch(() => {});
  const write = async (text: string) => {
    if (output.errored) throw output.errored;
    if (!output.write(text)) await once(output, 'drain');
  };
  const counts: Record<string, number> = {};
  try {
    const header = JSON.stringify(metadata);
    await write(header.slice(0, -1));
    let needsComma = Object.keys(metadata).length > 0;
    for (const [key, table] of Object.entries(tables)) {
      await write((needsComma ? ',' : '') + JSON.stringify(key) + ':[');
      let count = 0;
      for await (const row of iterateRows(table.model, table.args, table.batchSize ?? 100)) {
        await write((count ? ',' : '') + JSON.stringify(row));
        count++;
      }
      counts[key] = count;
      await write(']');
      needsComma = true;
    }
    await write('}');
    output.end();
    await completion;
    await fs.promises.rename(partialPath, filePath);
    return counts;
  } catch (error) {
    output.destroy();
    await completion.catch(() => {});
    if (ownsPartial) await fs.promises.unlink(partialPath).catch(() => {});
    throw error;
  } finally {
    snapshotInProgress = false;
  }
}
