/** Keyset pagination keeps large tables out of the application's heap. */
export async function* iterateRows(model: any, args: any = {}, batchSize = 100): AsyncGenerator<any> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Batch size must be a positive integer');
  let lastId: string | undefined;
  while (true) {
    const rows = await model.findMany({
      ...args,
      where: lastId ? { AND: [args.where || {}, { id: { gt: lastId } }] } : args.where,
      orderBy: { id: 'asc' },
      take: batchSize
    });
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    lastId = rows[rows.length - 1].id;
    if (!lastId) throw new Error('Batched queries must include the id field');
    if (rows.length < batchSize) return;
  }
}
