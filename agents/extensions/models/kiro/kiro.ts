/**
 * Runs Kiro CLI (`kiro-cli chat`) headless with a prompt and records the
 * answer, credits, duration, tool calls and failure class, so a workflow can
 * hand subtasks to a cheaper model and check what each one cost.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import { childEnv, runProcess } from "../_lib/process.ts";
import {
  commonGlobalArgs,
  commonInvokeArgs,
  type Ctx as AgentCtx,
  failIfNotOk,
  InvocationSchema,
  runAgent,
  type ToolProfile,
  TranscriptSchema,
} from "../_lib/agent.ts";
import { parseStream } from "./_lib/stream.ts";

/** Kiro agent written to ~/.kiro/agents for the readonly tool profile. */
export const READONLY_AGENT_NAME = "swamp-agents-kiro-readonly";
// Not `code`: its pattern_rewrite operation writes files.
const READONLY_TOOLS = ["read", "grep", "glob"];

/** The readonly agent config: file reading and code search tools only. */
export function readonlyAgentConfig(): string {
  return `${
    JSON.stringify(
      {
        name: READONLY_AGENT_NAME,
        description:
          "Read-only agent for @cachehit/agents/kiro: reads and searches files, cannot write or run commands",
        prompt: null,
        mcpServers: {},
        tools: READONLY_TOOLS,
        allowedTools: READONLY_TOOLS,
        resources: [],
        hooks: {},
        useLegacyMcpJson: false,
      },
      null,
      2,
    )
  }\n`;
}

const GlobalArgsSchema = z.object({
  kiroPath: z.string().min(1).default("kiro-cli").describe(
    "kiro-cli executable, resolved on PATH unless absolute",
  ),
  defaultModel: z.string().min(1).default("auto").describe(
    "Kiro model ID used when invoke omits model; see listModels",
  ),
  defaultAgent: z.string().min(1).optional().describe(
    "Kiro agent (context profile) for the actor profile; Kiro's default agent when unset",
  ),
  ...commonGlobalArgs,
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InvokeArgsSchema = z.object({
  ...commonInvokeArgs,
  model: z.string().min(1).optional().describe(
    "Kiro model ID, for example claude-haiku-4.5; defaults to defaultModel",
  ),
  agent: z.string().min(1).optional().describe(
    "Kiro agent for the actor profile; overrides defaultAgent",
  ),
});
type InvokeArgs = z.infer<typeof InvokeArgsSchema>;

const ModelListSchema = z.object({
  defaultModel: z.string().nullable(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    contextWindowTokens: z.number().nullable(),
    rateMultiplier: z.number().nullable(),
    rateUnit: z.string().nullable(),
  })),
  listedAt: z.string(),
});

type Ctx = AgentCtx<GlobalArgs>;

/** Command-line arguments for one headless `kiro-cli chat` run. */
export function buildChatArgs(opts: {
  model: string;
  toolProfile: ToolProfile;
  agent: string | null;
  effort: string | null;
}): string[] {
  const args = [
    "chat",
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
  ];
  if (opts.toolProfile === "readonly") {
    args.push(
      "--agent",
      READONLY_AGENT_NAME,
      `--trust-tools=${READONLY_TOOLS.join(",")}`,
    );
  } else {
    // A headless run cannot answer permission prompts.
    if (opts.agent) args.push("--agent", opts.agent);
    args.push("--trust-all-tools");
  }
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

/** Writes the readonly agent to ~/.kiro/agents when missing or outdated. */
async function ensureReadonlyAgent(home: string | undefined): Promise<void> {
  if (!home) {
    throw new Error("HOME is not set; cannot install the readonly agent");
  }
  const dir = `${home}/.kiro/agents`;
  const path = `${dir}/${READONLY_AGENT_NAME}.json`;
  const want = readonlyAgentConfig();
  const have = await Deno.readTextFile(path).catch(() => null);
  if (have === want) return;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, want);
}

/** Runs Kiro, retrying rate limits, killed processes and (optionally) non-JSON answers. */
function invoke(args: InvokeArgs, ctx: Ctx, requireJson: boolean) {
  const g = ctx.globalArgs;
  const toolProfile = args.toolProfile ?? g.defaultToolProfile;
  if (toolProfile === "readonly" && args.agent) {
    throw new Error(
      "agent applies only to toolProfile actor; readonly uses its own read-only agent",
    );
  }
  const agent = toolProfile === "actor"
    ? args.agent ?? g.defaultAgent ?? null
    : null;
  const model = args.model ?? g.defaultModel;
  return runAgent(
    {
      label: "Kiro",
      command: g.kiroPath,
      pathArg: "kiroPath",
      cliArgs: buildChatArgs({
        model,
        toolProfile,
        agent,
        effort: args.effort ?? null,
      }),
      parse: parseStream,
      model,
      toolProfile,
      agent,
      prepare: toolProfile === "readonly"
        ? (env) => ensureReadonlyAgent(env.HOME)
        : undefined,
    },
    args,
    ctx,
    requireJson,
  );
}

/** Parses `kiro-cli chat --list-models --format json`. */
export function parseModelList(stdout: string) {
  const data = JSON.parse(stdout) as {
    models?: Record<string, unknown>[];
    default_model?: string;
  };
  if (!Array.isArray(data.models)) {
    throw new Error("kiro-cli --list-models returned no models array");
  }
  const s = (v: unknown) => typeof v === "string" ? v : null;
  const n = (v: unknown) => typeof v === "number" ? v : null;
  return {
    defaultModel: s(data.default_model),
    models: data.models.map((m) => ({
      id: s(m.model_id) ?? "",
      name: s(m.model_name) ?? s(m.model_id) ?? "",
      description: s(m.description) ?? "",
      contextWindowTokens: n(m.context_window_tokens),
      rateMultiplier: n(m.rate_multiplier),
      rateUnit: s(m.rate_unit),
    })).filter((m) => m.id),
  };
}

const lifetime = "30d" as const;

/** Kiro CLI agent model. */
export const model = {
  type: "@cachehit/agents/kiro",
  version: "2026.10.27.2",
  upgrades: [{
    toVersion: "2026.10.27.1",
    description:
      "Adds attempts and requests to invocation records; credits now sum every attempt",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.10.27.2",
    description:
      "Adds costUsd and tokens to invocation records, shared with @cachehit/agents/claude; always null for Kiro",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  globalArguments: GlobalArgsSchema,
  resources: {
    invocation: {
      description:
        "One Kiro run: model, success, failure class, credits and requests summed over every attempt, each attempt, duration, tool calls, answer preview",
      schema: InvocationSchema,
      lifetime,
      garbageCollection: 100,
    },
    transcript: {
      description: "Full prompt and answer of an invocation",
      schema: TranscriptSchema,
      lifetime,
      garbageCollection: 100,
    },
    models: {
      description: "Models Kiro offers, with their credit rate multipliers",
      schema: ModelListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    invoke: {
      description:
        "Run Kiro headless with a prompt and record the answer, credits and duration",
      arguments: InvokeArgsSchema,
      execute: async (args: InvokeArgs, ctx: Ctx) => {
        const { handles, attempt } = await invoke(args, ctx, false);
        failIfNotOk("Kiro", attempt);
        return { dataHandles: handles };
      },
    },
    invokeAndParse: {
      description:
        "Like invoke, but the answer must contain JSON; stores it as parsed and retries when it does not",
      arguments: InvokeArgsSchema,
      execute: async (args: InvokeArgs, ctx: Ctx) => {
        const { handles, attempt } = await invoke(args, ctx, true);
        failIfNotOk("Kiro", attempt);
        return { dataHandles: handles };
      },
    },
    listModels: {
      description:
        "Store the models Kiro offers with their credit rate multipliers",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Listing Kiro models with {path}", {
          path: g.kiroPath,
        });
        const result = await runProcess(
          g.kiroPath,
          ["chat", "--list-models", "--format", "json"],
          {
            cwd: Deno.cwd(),
            stdin: "",
            env: childEnv(Deno.env.toObject()),
            wallTimeoutMs: 60_000,
            idleTimeoutMs: 60_000,
            pathArg: "kiroPath",
          },
        );
        if (result.code !== 0) {
          throw new Error(
            `kiro-cli --list-models failed (exit ${result.code}): ${
              result.stderr.trim().slice(-300)
            }`,
          );
        }
        const list = parseModelList(result.stdout);
        ctx.logger.info("Kiro offers {count} models", {
          count: list.models.length,
        });
        const handle = await ctx.writeResource("models", "models", {
          ...list,
          listedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
