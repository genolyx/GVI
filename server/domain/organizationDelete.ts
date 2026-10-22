import { sql } from "drizzle-orm";
import { requireDb } from "./tenant";

/** Child tables first, then their parents, so a tenant delete respects foreign keys. */
export function orderTenantDeletes(
  tables: readonly string[],
  edges: readonly { child: string; parent: string }[]
): string[] {
  const names = new Set(tables);
  const children = new Map<string, Set<string>>();
  for (const { child, parent } of edges) {
    if (child === parent || !names.has(child) || !names.has(parent)) continue;
    const values = children.get(parent) ?? new Set<string>();
    values.add(child);
    children.set(parent, values);
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (table: string) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(`Unexpected tenant-table FK cycle at ${table}`);
    }
    visiting.add(table);
    for (const child of children.get(table) ?? []) visit(child);
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  };
  for (const table of names) visit(table);
  return ordered;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unexpected table name: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Remove every row that belongs to this organization, then the organization.
 * Table order follows foreign keys among tables that carry organizationId.
 */
export async function deleteOrganizationGraph(organizationId: number): Promise<void> {
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error("Organization id must be a positive integer.");
  }
  const db = await requireDb();
  const scoped = await db.execute<{ table_name: string }>(sql`
    SELECT DISTINCT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attname = 'organizationId'
      AND NOT a.attisdropped
  `);
  const relations = await db.execute<{ child: string; parent: string }>(sql`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE fk.contype = 'f' AND n.nspname = 'public'
  `);
  const ordered = orderTenantDeletes(
    scoped.rows.map(row => row.table_name),
    relations.rows
  );
  await db.transaction(async tx => {
    for (const table of ordered) {
      await tx.execute(
        sql.raw(
          `DELETE FROM ${quoteIdent(table)} WHERE "organizationId" = ${organizationId}`
        )
      );
    }
    await tx.execute(sql`DELETE FROM organizations WHERE id = ${organizationId}`);
  });
}
