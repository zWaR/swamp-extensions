// extensions/models/mysql_client/mysql_client_test.ts
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { Buffer } from "node:buffer";
import {
  assertReadOnlySql,
  columnTypeName,
  GlobalArgsSchema,
  mapConnectionError,
  QueryArgsSchema,
  serializeRow,
  serializeValue,
} from "./mysql_client.ts";

const HOST = "127.0.0.1";
const PORT = 3308;

Deno.test("mapConnectionError: ECONNREFUSED points at the port-forward", () => {
  const err = mapConnectionError({ code: "ECONNREFUSED" }, HOST, PORT);
  assertStringIncludes(err.message, "Nothing is listening on 127.0.0.1:3308");
  assertStringIncludes(err.message, "port-forward");
});

Deno.test("mapConnectionError: ETIMEDOUT points at the port-forward", () => {
  const err = mapConnectionError({ code: "ETIMEDOUT" }, HOST, PORT);
  assertStringIncludes(err.message, "Nothing is listening on 127.0.0.1:3308");
  assertStringIncludes(err.message, "port-forward");
});

Deno.test("mapConnectionError: ENOTFOUND mentions host and port", () => {
  const err = mapConnectionError({ code: "ENOTFOUND" }, "db.invalid", 3307);
  assertStringIncludes(err.message, "db.invalid");
  assertStringIncludes(err.message, "db.invalid:3307");
});

Deno.test("mapConnectionError: network code on cause is recognised", () => {
  const err = mapConnectionError(
    { message: "wrapped", cause: { code: "ECONNREFUSED" } },
    HOST,
    PORT,
  );
  assertStringIncludes(err.message, "Nothing is listening on 127.0.0.1:3308");
  assertStringIncludes(err.message, "port-forward");
});

Deno.test("mapConnectionError: ER_ACCESS_DENIED_ERROR -> access denied", () => {
  const err = mapConnectionError(
    {
      code: "ER_ACCESS_DENIED_ERROR",
      errno: 1045,
      message: "Access denied for user 'app'@'10.0.0.1' (using password: YES)",
    },
    HOST,
    PORT,
  );
  assertStringIncludes(err.message, "Access denied");
  assertStringIncludes(err.message, "127.0.0.1:3308");
});

Deno.test("mapConnectionError: unrelated error passes its message through", () => {
  const err = mapConnectionError(
    Object.assign(new Error("Table 'app.nope' doesn't exist"), {
      code: "ER_NO_SUCH_TABLE",
      errno: 1146,
    }),
    HOST,
    PORT,
  );
  assertEquals(err.message, "Table 'app.nope' doesn't exist");
  assertEquals((err as Error & { code?: string }).code, "ER_NO_SUCH_TABLE");
  assertEquals((err as Error & { errno?: number }).errno, 1146);
});

Deno.test("mapConnectionError: non-object error is stringified", () => {
  assertEquals(mapConnectionError("boom", HOST, PORT).message, "boom");
});

Deno.test("mapConnectionError: never leaks the configured password", () => {
  const password = "s3cr3t-P@ssw0rd-do-not-leak";
  const config = { host: HOST, port: PORT, user: "app", password };
  for (const code of [undefined, "ECONNREFUSED", "ER_ACCESS_DENIED_ERROR"]) {
    const err = mapConnectionError(
      Object.assign(new Error("Something failed"), { code, config }),
      HOST,
      PORT,
    );
    assert(!err.message.includes(password), `leaked for code ${code}`);
    assert(!JSON.stringify(err).includes(password), `leaked for code ${code}`);
    assertEquals((err as Error & { config?: unknown }).config, undefined);
  }
});

Deno.test("serializeValue: Date -> ISO string", () => {
  assertEquals(
    serializeValue(new Date("2026-10-29T12:34:56.789Z")),
    "2026-10-29T12:34:56.789Z",
  );
});

Deno.test("serializeValue: Uint8Array and Buffer -> base64", () => {
  assertEquals(serializeValue(new Uint8Array([104, 105])), "aGk=");
  assertEquals(serializeValue(Buffer.from("hi")), "aGk=");
});

Deno.test("serializeValue: Uint8Array view honours its offset", () => {
  const backing = new Uint8Array([0, 104, 105, 0]);
  assertEquals(serializeValue(backing.subarray(1, 3)), "aGk=");
});

Deno.test("serializeValue: bigint -> string, DECIMAL string unchanged", () => {
  assertEquals(serializeValue(123n), "123");
  assertEquals(serializeValue("12.50"), "12.50");
});

Deno.test("serializeValue: null and undefined -> null", () => {
  assertEquals(serializeValue(null), null);
  assertEquals(serializeValue(undefined), null);
});

Deno.test("serializeValue: numbers and booleans unchanged", () => {
  assertEquals(serializeValue(42), 42);
  assertEquals(serializeValue(-1.5), -1.5);
  assertEquals(serializeValue(true), true);
  assertEquals(serializeValue(false), false);
});

Deno.test("serializeValue: nested JSON object serialized recursively", () => {
  assertEquals(
    serializeValue({
      a: 1,
      b: { when: new Date("2026-01-01T00:00:00.000Z"), big: 9n },
      list: [new Uint8Array([104, 105]), null, undefined, "x"],
    }),
    {
      a: 1,
      b: { when: "2026-01-01T00:00:00.000Z", big: "9" },
      list: ["aGk=", null, null, "x"],
    },
  );
});

Deno.test("serializeRow: serializes every column", () => {
  assertEquals(
    serializeRow({
      id: "9007199254740993",
      createdAt: new Date("2026-10-29T00:00:00.000Z"),
      blob: Buffer.from("hi"),
      price: "12.50",
      deletedAt: null,
      active: true,
    }),
    {
      id: "9007199254740993",
      createdAt: "2026-10-29T00:00:00.000Z",
      blob: "aGk=",
      price: "12.50",
      deletedAt: null,
      active: true,
    },
  );
});

Deno.test("columnTypeName: known codes map to names", () => {
  assertEquals(columnTypeName({ columnType: 3 }), "LONG");
  assertEquals(columnTypeName({ columnType: 253 }), "VAR_STRING");
  assertEquals(columnTypeName({ columnType: 246 }), "NEWDECIMAL");
  assertEquals(columnTypeName({ type: 12 }), "DATETIME");
});

Deno.test("columnTypeName: unknown code falls back to a string", () => {
  assertEquals(columnTypeName({ columnType: 199 }), "199");
  assertEquals(columnTypeName({}), "UNKNOWN");
});

Deno.test("QueryArgsSchema: valid input parses with maxRows default", () => {
  const parsed = QueryArgsSchema.parse({
    queries: [{ name: "users", sql: "SELECT 1", params: ["a", 1, true, null] }],
  });
  assertEquals(parsed.maxRows, 1000);
  assertEquals(parsed.queries[0].params, ["a", 1, true, null]);
});

Deno.test("QueryArgsSchema: empty queries rejected", () => {
  assert(!QueryArgsSchema.safeParse({ queries: [] }).success);
});

Deno.test("QueryArgsSchema: query name validation", () => {
  const ok = (name: string) =>
    QueryArgsSchema.safeParse({ queries: [{ name, sql: "SELECT 1" }] })
      .success;
  for (const name of ["users", "orders.by-day", "a_b"]) {
    assert(ok(name), `expected "${name}" to be accepted`);
  }
  for (const name of ["bad name", "-x", "a..b", ""]) {
    assert(!ok(name), `expected "${name}" to be rejected`);
  }
});

Deno.test("QueryArgsSchema: object param rejected", () => {
  const result = QueryArgsSchema.safeParse({
    queries: [{ name: "q", sql: "SELECT ?", params: [{ a: 1 }] }],
  });
  assert(!result.success);
});

Deno.test("QueryArgsSchema: maxRows above 50000 rejected", () => {
  const queries = [{ name: "q", sql: "SELECT 1" }];
  assert(QueryArgsSchema.safeParse({ queries, maxRows: 50000 }).success);
  assert(!QueryArgsSchema.safeParse({ queries, maxRows: 50001 }).success);
});

Deno.test("QueryArgsSchema: duplicate names rejected", () => {
  const result = QueryArgsSchema.safeParse({
    queries: [
      { name: "dup", sql: "SELECT 1" },
      { name: "dup", sql: "SELECT 2" },
    ],
  });
  assert(!result.success);
  assertEquals(result.error.issues.map((i) => [i.path, i.message]), [
    [["queries", 1, "name"], 'Duplicate query name "dup"'],
  ]);
});

Deno.test("GlobalArgsSchema: defaults host, port and connectTimeoutMs", () => {
  const parsed = GlobalArgsSchema.parse({ user: "app", password: "pw" });
  assertEquals(parsed.host, "127.0.0.1");
  assertEquals(parsed.port, 3308);
  assertEquals(parsed.connectTimeoutMs, 5000);
  assertEquals(parsed.database, undefined);
});

Deno.test("GlobalArgsSchema: missing user rejected", () => {
  assert(!GlobalArgsSchema.safeParse({ password: "pw" }).success);
});

Deno.test("assertReadOnlySql: read statements pass", () => {
  for (
    const sql of [
      "SELECT 1",
      "  select * from orders",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "(SELECT 1) UNION (SELECT 2)",
      "SHOW TABLES",
      "DESC orders",
      "DESCRIBE orders",
      "EXPLAIN SELECT 1",
      "/* note */ SELECT 1",
      "-- note\nSELECT 1",
      "# note\nSELECT 1",
      "SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1",
    ]
  ) assertReadOnlySql(sql);
});

Deno.test("assertReadOnlySql: writes, DDL and transaction control refused", () => {
  for (
    const sql of [
      "DROP TABLE orders",
      "ALTER TABLE orders ADD c INT",
      "TRUNCATE orders",
      "CREATE TABLE t (id INT)",
      "RENAME TABLE a TO b",
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "COMMIT",
      "SET autocommit = 1",
      "CALL proc()",
      "/* sneaky */ DROP TABLE t",
      "",
      "   ",
    ]
  ) assertThrows(() => assertReadOnlySql(sql), Error, "Only SELECT");
});

Deno.test("assertReadOnlySql: executable comments and INTO OUTFILE refused", () => {
  assertThrows(
    () => assertReadOnlySql("/*!50000 DROP TABLE t */"),
    Error,
    "Executable comments",
  );
  assertThrows(
    () => assertReadOnlySql("SELECT 1 /*! , SLEEP(1) */"),
    Error,
    "Executable comments",
  );
  assertThrows(
    () => assertReadOnlySql("SELECT * FROM t INTO OUTFILE '/tmp/x'"),
    Error,
    "INTO OUTFILE",
  );
  assertThrows(
    () => assertReadOnlySql("SELECT a INTO dumpfile '/tmp/x' FROM t"),
    Error,
    "INTO OUTFILE",
  );
});
