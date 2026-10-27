/**
 * Runs Claude Code (`claude -p`) headless with a prompt and records the
 * answer, dollar cost, token counts, duration, tool calls and failure class,
 * so a workflow can hand subtasks to a cheaper model and check what each one
 * cost.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
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

/** Built-in tools of the readonly profile; MCP servers are not loaded. */
export const READONLY_TOOLS = ["Read", "Grep", "Glob"];

const GlobalArgsSchema = z.object({
  claudePath: z.string().min(1).default("claude").describe(
    "Claude Code executable, resolved on PATH unless absolute",
  ),
  defaultModel: z.string().min(1).default("sonnet").describe(
    "Model alias (haiku, sonnet, opus) or full model ID used when invoke omits model",
  ),
  ...commonGlobalArgs,
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InvokeArgsSchema = z.object({
  ...commonInvokeArgs,
  model: z.string().min(1).optional().describe(
    "Model alias or ID, for example haiku or claude-sonnet-5-5; defaults to defaultModel",
  ),
});
type InvokeArgs = z.infer<typeof InvokeArgsSchema>;

type Ctx = AgentCtx<GlobalArgs>;

/** Command-line arguments for one headless `claude -p` run. */
export function buildArgs(opts: {
  model: string;
  toolProfile: ToolProfile;
  effort: string | null;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--no-session-persistence",
  ];
  if (opts.toolProfile === "readonly") {
    // --tools limits built-in tools only, so MCP servers are dropped too;
    // dontAsk denies anything that would need a permission prompt.
    args.push(
      "--tools",
      READONLY_TOOLS.join(","),
      "--allowedTools",
      READONLY_TOOLS.join(","),
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
    );
  } else {
    // A headless run cannot answer permission prompts.
    args.push("--dangerously-skip-permissions");
  }
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

/** Runs Claude Code, retrying rate limits, killed processes and (optionally) non-JSON answers. */
function invoke(args: InvokeArgs, ctx: Ctx, requireJson: boolean) {
  const g = ctx.globalArgs;
  const toolProfile = args.toolProfile ?? g.defaultToolProfile;
  const model = args.model ?? g.defaultModel;
  return runAgent(
    {
      label: "Claude Code",
      command: g.claudePath,
      pathArg: "claudePath",
      cliArgs: buildArgs({ model, toolProfile, effort: args.effort ?? null }),
      parse: parseStream,
      model,
      toolProfile,
      agent: null,
    },
    args,
    ctx,
    requireJson,
  );
}

const lifetime = "30d" as const;

/** Claude Code agent model. */
export const model = {
  type: "@cachehit/agents/claude",
  version: "2026.10.27.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    invocation: {
      description:
        "One Claude Code run: model, success, failure class, dollar cost and tokens summed over every attempt, each attempt, duration, tool calls, answer preview",
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
  },
  methods: {
    invoke: {
      description:
        "Run Claude Code headless with a prompt and record the answer, cost, tokens and duration",
      arguments: InvokeArgsSchema,
      execute: async (args: InvokeArgs, ctx: Ctx) => {
        const { handles, attempt } = await invoke(args, ctx, false);
        failIfNotOk("Claude Code", attempt);
        return { dataHandles: handles };
      },
    },
    invokeAndParse: {
      description:
        "Like invoke, but the answer must contain JSON; stores it as parsed and retries when it does not",
      arguments: InvokeArgsSchema,
      execute: async (args: InvokeArgs, ctx: Ctx) => {
        const { handles, attempt } = await invoke(args, ctx, true);
        failIfNotOk("Claude Code", attempt);
        return { dataHandles: handles };
      },
    },
  },
};
