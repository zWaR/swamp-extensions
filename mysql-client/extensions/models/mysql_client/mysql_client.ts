/**
 * Generic MySQL / Aurora MySQL client — checks connectivity, runs read-only
 * SQL and snapshots table/column metadata against any MySQL-compatible
 * server reachable over TCP.
 *
 * The network path is a precondition the user owns. For a cluster-internal
 * database that usually means a port-forward started by hand, e.g.
 * `kubectl -n <namespace> port-forward deployment/db-proxy 3308:3306`.
 * This extension never opens, checks or manages tunnels: it runs no kubectl
 * and spawns no child processes. It simply connects to `host:port` and, when
 * nothing is listening, says so.
 *
 * Read-only guarantee, in two layers: `query` refuses any statement that is
 * not SELECT, WITH, SHOW, DESC/DESCRIBE or EXPLAIN before connecting, and runs
 * the rest inside `START TRANSACTION READ ONLY` followed by an unconditional
 * `ROLLBACK`, so the server also refuses INSERT/UPDATE/DELETE. A user with
 * only SELECT grants (or the Aurora reader endpoint) is still recommended.
 *
 * Examples:
 *
 *     swamp behavior run my-db check
 *     swamp behavior run my-db query --input-file queries.yaml
 *     swamp behavior run my-db schema
 *
 * with `queries.yaml`:
 *
 *     queries:
 *       - name: recent-orders
 *         sql: SELECT id, status, createdAt FROM orders WHERE createdAt > ? ORDER BY createdAt DESC
 *         params: ["2026-10-01"]
 *     maxRows: 100
 *
 * @module
 */
// extensions/models/mysql_client/mysql_client.ts
import { z } from "npm:zod@4";
import mysql from "npm:mysql2@3.24.6/promise";
import type { Connection, FieldPacket } from "npm:mysql2@3.24.6/promise";
import { Buffer } from "node:buffer";

/** Connection settings shared by every method. */
export const GlobalArgsSchema = z.object({
  host: z.string().min(1).default("127.0.0.1").describe(
    "Host to connect to, typically the local end of your port-forward",
  ),
  port: z.number().int().min(1).max(65535).default(3308).describe(
    "TCP port to connect to, typically the local end of your port-forward",
  ),
  database: z.string().min(1).optional().describe(
    "Default database (schema) to use; optional",
  ),
  user: z.string().min(1).describe("MySQL user name"),
  password: z.string().meta({ sensitive: true }).describe(
    "MySQL password (store in a vault and reference it via CEL)",
  ),
  connectTimeoutMs: z.number().int().positive().default(5000).describe(
    "Connect timeout in milliseconds",
  ),
});
/** Parsed global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type Ctx = {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string; version?: number }>;
  logger: { info: (message: string, fields?: Record<string, unknown>) => void };
};

type ErrorLike = {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  cause?: { code?: unknown };
};

const NETWORK_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as ErrorLike;
  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return e.code;
  // mysql2 sometimes wraps the socket error; its code then lives on `cause`.
  const causeCode = e.cause?.code;
  if (typeof causeCode === "string" && NETWORK_CODES.has(causeCode)) {
    return causeCode;
  }
  return typeof e.code === "string" ? e.code : undefined;
}

/**
 * Turns a mysql2 / socket error into a user-facing Error. Never includes the
 * password or the connection config.
 */
export function mapConnectionError(
  err: unknown,
  host: string,
  port: number,
): Error {
  const code = errorCode(err);
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return new Error(
      `Nothing is listening on ${host}:${port}. Is your port-forward running?`,
    );
  }
  if (code === "ENOTFOUND") {
    return new Error(
      `Host ${host} cannot be resolved (${host}:${port}). Is your port-forward running?`,
    );
  }
  if (code === "ER_ACCESS_DENIED_ERROR") {
    return new Error(
      `Access denied for the configured user on ${host}:${port}. Check the user and password.`,
    );
  }
  const message = typeof err === "object" && err !== null &&
      typeof (err as ErrorLike).message === "string"
    ? (err as ErrorLike).message as string
    : String(err);
  const mapped = new Error(message);
  if (code) Object.assign(mapped, { code });
  const errno = (err as ErrorLike | null)?.errno;
  if (typeof errno === "number") Object.assign(mapped, { errno });
  return mapped;
}

/**
 * Opens a connection, runs `fn`, and always closes the connection. Errors
 * from connecting and from `fn` are passed through mapConnectionError.
 */
export async function withConnection<T>(
  globalArgs: GlobalArgs,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const { host, port, user, password, database, connectTimeoutMs } = globalArgs;
  let conn: Connection;
  try {
    conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      connectTimeout: connectTimeoutMs,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
    });
  } catch (err) {
    throw mapConnectionError(err, host, port);
  }
  try {
    return await fn(conn);
  } catch (err) {
    throw mapConnectionError(err, host, port);
  } finally {
    try {
      await conn.end();
    } catch {
      conn.destroy();
    }
  }
}

/**
 * Converts one mysql2 column value into JSON-safe data. DECIMAL and BIGINT
 * already arrive as strings (supportBigNumbers + bigNumberStrings) and stay
 * that way.
 */
export function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString(
      "base64",
    );
  }
  if (typeof v === "bigint") return v.toString();
  if (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  ) {
    return v;
  }
  if (Array.isArray(v)) return v.map(serializeValue);
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map((
        [k, inner],
      ) => [k, serializeValue(inner)]),
    );
  }
  return String(v);
}

/** Converts every column value of a row with serializeValue. */
export function serializeRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, serializeValue(v)]),
  );
}

// MySQL protocol column type codes (include/field_types.h).
const COLUMN_TYPE_NAMES: Record<number, string> = {
  0: "DECIMAL",
  1: "TINY",
  2: "SHORT",
  3: "LONG",
  4: "FLOAT",
  5: "DOUBLE",
  6: "NULL",
  7: "TIMESTAMP",
  8: "LONGLONG",
  9: "INT24",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "NEWDECIMAL",
  247: "ENUM",
  248: "SET",
  249: "TINY_BLOB",
  250: "MEDIUM_BLOB",
  251: "LONG_BLOB",
  252: "BLOB",
  253: "VAR_STRING",
  254: "STRING",
  255: "GEOMETRY",
};

/** Readable type name for a mysql2 field; falls back to the numeric code. */
export function columnTypeName(
  field: Pick<FieldPacket, "columnType" | "type">,
): string {
  const code = field.columnType ?? field.type;
  if (code === undefined) return "UNKNOWN";
  return COLUMN_TYPE_NAMES[code] ?? String(code);
}

/** Strings from information_schema; binary-collated values arrive as Buffers. */
function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
  }
  return String(v);
}

// Statement kinds `query` accepts. DDL, COMMIT and the like would end the
// read-only transaction (MySQL commits implicitly first), so they never run.
const READ_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "SHOW",
  "DESC",
  "DESCRIBE",
  "EXPLAIN",
]);

/**
 * Throws unless `sql` is a single read statement. Leading comments are
 * skipped; MySQL executable comments (`/*! ... *\/`) and SELECT ... INTO
 * OUTFILE/DUMPFILE are refused because they can run or write anything.
 */
export function assertReadOnlySql(sql: string): void {
  if (sql.includes("/*!")) {
    throw new Error("Executable comments (/*! ... */) are not allowed");
  }
  const body = sql.replace(
    /^(?:\s+|\/\*[\s\S]*?\*\/|(?:--\s|#)[^\n]*\n?)*/,
    "",
  );
  const keyword = (body.match(/^\(*\s*([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  if (!READ_KEYWORDS.has(keyword)) {
    throw new Error(
      `Only ${[...READ_KEYWORDS].join(", ")} statements are allowed; got ${
        keyword || "an empty statement"
      }`,
    );
  }
  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(sql)) {
    throw new Error("SELECT ... INTO OUTFILE/DUMPFILE is not allowed");
  }
}

const ER_UNKNOWN_SYSTEM_VARIABLE = 1193;

const ConnectionSchema = z.object({
  version: z.string(),
  auroraVersion: z.string().nullable(),
  currentUser: z.string(),
  database: z.string().nullable(),
  readOnly: z.boolean(),
  host: z.string(),
  port: z.number(),
  checkedAt: z.string().describe("ISO timestamp of the check"),
});

const ResultSchema = z.object({
  name: z.string(),
  sql: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
  truncated: z.boolean(),
  durationMs: z.number(),
});

const SchemaSchema = z.object({
  database: z.string(),
  tables: z.array(z.object({
    name: z.string(),
    type: z.string(),
    columns: z.array(z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
      key: z.string(),
      default: z.string().nullable(),
    })),
  })),
  fetchedAt: z.string(),
});

const CheckArgsSchema = z.object({});

/** Arguments of `query`: uniquely named statements and a per-query row cap. */
export const QueryArgsSchema = z.object({
  queries: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/).describe(
      "Unique query name; the result is stored as result-<name>",
    ),
    sql: z.string().min(1).describe(
      "SQL text; use ? placeholders for values",
    ),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional().describe("Values bound to the ? placeholders, in order"),
  })).min(1).superRefine((queries, ctx) => {
    const seen = new Set<string>();
    queries.forEach((q, i) => {
      if (seen.has(q.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate query name "${q.name}"`,
          path: [i, "name"],
        });
      }
      seen.add(q.name);
    });
  }),
  maxRows: z.number().int().min(1).max(50000).default(1000).describe(
    "Maximum rows kept per query; extra rows are dropped and truncated is set",
  ),
});

/** Arguments of `schema`: the database to describe. */
export const SchemaArgsSchema = z.object({
  database: z.string().min(1).optional().describe(
    "Database to describe; defaults to the global database",
  ),
});

/** The `@cachehit/mysql-client` model: `check`, `query` and `schema`. */
export const model = {
  type: "@cachehit/mysql-client",
  version: "2026.10.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "connection": {
      description: "Server identity and session facts from the last check",
      schema: ConnectionSchema,
      lifetime: "7d",
      garbageCollection: 5,
    },
    "result": {
      description: "Rows returned by one read-only query",
      schema: ResultSchema,
      lifetime: "7d",
      garbageCollection: 5,
    },
    "schema": {
      description: "Tables and columns of the configured database",
      schema: SchemaSchema,
      lifetime: "7d",
      garbageCollection: 5,
    },
  },
  methods: {
    check: {
      description:
        "Connect and report server version, Aurora version, current user, database and read-only flag",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: Ctx,
      ) => {
        const { host, port } = context.globalArgs;
        const facts = await withConnection(context.globalArgs, async (conn) => {
          const [rows] = await conn.query(
            "SELECT VERSION() AS version, CURRENT_USER() AS currentUser, DATABASE() AS db, @@read_only AS readOnly",
          );
          const row = (rows as Record<string, unknown>[])[0];
          let auroraVersion: string | null = null;
          try {
            const [aurora] = await conn.query(
              "SELECT @@aurora_version AS auroraVersion",
            );
            const value = (aurora as Record<string, unknown>[])[0]
              ?.auroraVersion;
            auroraVersion = value == null ? null : String(value);
          } catch (err) {
            const e = err as ErrorLike;
            if (
              e?.errno !== ER_UNKNOWN_SYSTEM_VARIABLE &&
              e?.code !== "ER_UNKNOWN_SYSTEM_VARIABLE"
            ) {
              throw err;
            }
          }
          return {
            version: String(row.version),
            auroraVersion,
            currentUser: String(row.currentUser),
            database: row.db == null ? null : String(row.db),
            readOnly: Number(row.readOnly) === 1,
          };
        });
        const handle = await context.writeResource("connection", "connection", {
          ...facts,
          host,
          port,
          checkedAt: new Date().toISOString(),
        });
        context.logger.info("Connected to MySQL {version} as {currentUser}", {
          version: facts.version,
          currentUser: facts.currentUser,
        });
        return { dataHandles: [handle] };
      },
    },
    query: {
      description:
        "Run one or more parameterized SQL statements inside a read-only transaction that is always rolled back",
      arguments: QueryArgsSchema,
      execute: async (
        args: z.infer<typeof QueryArgsSchema>,
        context: Ctx,
      ) => {
        const { host, port } = context.globalArgs;
        for (const q of args.queries) {
          try {
            assertReadOnlySql(q.sql);
          } catch (err) {
            throw new Error(
              `Query "${q.name}" refused: ${(err as Error).message}`,
            );
          }
        }
        const handles = await withConnection(
          context.globalArgs,
          async (conn) => {
            const written: { name: string; version?: number }[] = [];
            await conn.query("START TRANSACTION READ ONLY");
            try {
              for (const q of args.queries) {
                const start = performance.now();
                let rawRows: unknown;
                let fields: FieldPacket[] | undefined;
                try {
                  [rawRows, fields] = await conn.execute(q.sql, q.params ?? []);
                } catch (err) {
                  // Name the query, never its params or the credentials.
                  throw new Error(
                    `Query "${q.name}" failed: ${
                      mapConnectionError(err, host, port).message
                    }`,
                  );
                }
                const durationMs =
                  Math.round((performance.now() - start) * 100) / 100;
                const allRows = Array.isArray(rawRows)
                  ? rawRows as Record<string, unknown>[]
                  : [];
                const columns = (fields ?? []).map((f) => ({
                  name: f.name,
                  type: columnTypeName(f),
                }));
                const truncated = allRows.length > args.maxRows;
                const rows = allRows.slice(0, args.maxRows).map(serializeRow);
                written.push(
                  await context.writeResource("result", `result-${q.name}`, {
                    name: q.name,
                    sql: q.sql,
                    columns,
                    rows,
                    rowCount: rows.length,
                    truncated,
                    durationMs,
                  }),
                );
                context.logger.info(
                  "Query {name}: {rowCount} rows (truncated: {truncated}) in {durationMs}ms",
                  {
                    name: q.name,
                    rowCount: rows.length,
                    truncated,
                    durationMs,
                  },
                );
              }
            } finally {
              try {
                await conn.query("ROLLBACK");
              } catch {
                // Don't mask the original error; closing the connection
                // discards the transaction anyway.
              }
            }
            return written;
          },
        );
        return { dataHandles: handles };
      },
    },
    schema: {
      description:
        "Snapshot the tables and columns of a database from information_schema",
      arguments: SchemaArgsSchema,
      execute: async (
        args: z.infer<typeof SchemaArgsSchema>,
        context: Ctx,
      ) => {
        const db = args.database ?? context.globalArgs.database;
        if (!db) {
          throw new Error(
            "No database given: pass the database argument or set the global database",
          );
        }
        const tables = await withConnection(
          context.globalArgs,
          async (conn) => {
            const [tableRows] = await conn.execute(
              "SELECT TABLE_NAME AS tableName, TABLE_TYPE AS tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
              [db],
            );
            const [columnRows] = await conn.execute(
              "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS columnDefault FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
              [db],
            );
            const byName = new Map<
              string,
              {
                name: string;
                type: string;
                columns: {
                  name: string;
                  type: string;
                  nullable: boolean;
                  key: string;
                  default: string | null;
                }[];
              }
            >();
            for (const r of tableRows as Record<string, unknown>[]) {
              const name = asText(r.tableName) ?? "";
              byName.set(name, {
                name,
                type: asText(r.tableType) ?? "",
                columns: [],
              });
            }
            for (const r of columnRows as Record<string, unknown>[]) {
              byName.get(asText(r.tableName) ?? "")?.columns.push({
                name: asText(r.columnName) ?? "",
                type: asText(r.columnType) ?? "",
                nullable: asText(r.isNullable) === "YES",
                key: asText(r.columnKey) ?? "",
                default: asText(r.columnDefault),
              });
            }
            return [...byName.values()];
          },
        );
        const safeName = db.replace(/[^A-Za-z0-9._-]/g, "-");
        const handle = await context.writeResource(
          "schema",
          `schema-${safeName}`,
          { database: db, tables, fetchedAt: new Date().toISOString() },
        );
        context.logger.info(
          "Fetched schema of {database}: {tableCount} tables",
          {
            database: db,
            tableCount: tables.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
