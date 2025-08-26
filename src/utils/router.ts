import {
  MessageCreateParamsBase,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { get_encoding } from "tiktoken";
import { log } from "./log";

const enc = get_encoding("cl100k_base");

// Diagnostic tokenizer wrapper: logs non-string inputs with context to ~/.claude-code-router/claude-code-router.log
const safeEncode = (where: string, value: any): number => {
  if (typeof value !== "string") {
    let preview = "";
    try { preview = (JSON.stringify(value) ?? String(value)).slice(0, 200); } catch { preview = String(value); }
    log({ event: "tokenize_non_string", where, type: typeof value, isNull: value === null, isArray: Array.isArray(value), preview });
    value = ""; // keep behavior stable but record the anomaly
  }
  return enc.encode_ordinary(value).length;
};

const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += safeEncode("messages.content[string]", message.content);
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += safeEncode("messages.content[text]", contentPart.text);
          } else if (contentPart.type === "tool_use") {
            tokenCount += safeEncode("messages.content[tool_use.input(JSON)]", contentPart.input === undefined ? undefined : JSON.stringify(contentPart.input));
          } else if (contentPart.type === "tool_result") {
            tokenCount += safeEncode("messages.content[tool_result.content]", typeof contentPart.content === "string" ? contentPart.content : (contentPart.content === undefined ? undefined : JSON.stringify(contentPart.content)));
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += safeEncode("system[string]", system);
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += safeEncode("system[item.text]", item.text);
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += safeEncode("system[item.text.part]", textPart);
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += safeEncode("tools[name+description]", tool.name + tool.description);
      }
      if (tool.input_schema) {
        tokenCount += safeEncode("tools[input_schema(JSON)]", JSON.stringify(tool.input_schema));
      }
    });
  }
  return tokenCount;
};

// Strict validator to catch malformed parts before tokenization; logs and throws on critical issues
const validateMessageShapes = (messages: any[], system: any, tools: any[]): void => {
  const preview = (v: any) => {
    try { const s = JSON.stringify(v); return (s ?? String(v)).slice(0, 200); } catch { return String(v).slice(0, 200); }
  };
  // Validate messages -> tool_result.content must be a string when present
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const c = m && m.content;
      if (Array.isArray(c)) {
        for (let j = 0; j < c.length; j++) {
          const p = c[j];
          if (!p || typeof p !== "object") continue;
          if (p.type === "tool_result") {
            const hasContent = Object.prototype.hasOwnProperty.call(p as any, "content");
            const tuid = (p as any).tool_use_id ?? null;
            if (!hasContent) {
              // Note: Seen when a tool call was canceled/interrupted mid-flight. Do not crash CCR.
              log({ event: "pre_tokenize_tool_result_missing_content", index: i, partIndex: j, role: m?.role, tool_use_id: tuid });
              (p as any).content = "[ccr] tool_result missing content (likely canceled/interrupted tool); treating as empty.";
              continue; // Coerced; safe for downstream tokenization
            }
            const v = (p as any).content;
            if (typeof v !== "string") {
              // Coerce non-string content to a string to avoid tokenizer crashes
              log({ event: "pre_tokenize_tool_result_nonstring", index: i, partIndex: j, role: m?.role, tool_use_id: tuid, typeof: typeof v, isNull: v === null, hasContent: true, preview: preview(v) });
              try {
                (p as any).content = typeof v === "undefined" ? "" : JSON.stringify(v);
              } catch {
                (p as any).content = "";
              }
            }
          }
        }
      }
    }
  }
  // Soft validation for system shape (log only)
  if (Array.isArray(system)) {
    for (let k = 0; k < system.length; k++) {
      const item = system[k];
      if (!item || item.type !== "text") continue;
      const t = item.text;
      if (typeof t !== "string" && !Array.isArray(t)) {
        log({ event: "pre_tokenize_system_text_nonstring", index: k, typeof: typeof t, preview: preview(t) });
      }
      if (Array.isArray(t)) {
        for (let tpi = 0; tpi < t.length; tpi++) {
          const tp = t[tpi];
          if (typeof tp !== "string") {
            log({ event: "pre_tokenize_system_text_part_nonstring", index: k, partIndex: tpi, typeof: typeof tp, preview: preview(tp) });
          }
        }
      }
    }
  }
};

const getUseModel = async (req: any, tokenCount: number, config: any) => {
  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = config.Providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return `${finalProvider.name},${finalModel}`;
    }
    return req.body.model;
  }
  // if tokenCount is greater than the configured threshold, use the long context model
  if (!config.Router) {
    throw new Error("Router configuration is missing. Please check your config.json file.");
  }
  
  const longContextThreshold = config.Router.longContextThreshold || 60000;
  if (tokenCount > longContextThreshold && config.Router.longContext) {
    log(
      "Using long context model due to token count:",
      tokenCount,
      "threshold:",
      longContextThreshold
    );
    return config.Router.longContext;
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return model[1];
    }
  }
  // If the model is claude-3-5-haiku, use the background model
  if (
    req.body.model?.startsWith("claude-3-5-haiku") &&
    config.Router.background
  ) {
    log("Using background model for ", req.body.model);
    return config.Router.background;
  }
  // if exits thinking, use the think model
  if (req.body.thinking && config.Router.think) {
    log("Using think model for ", req.body.thinking);
    return config.Router.think;
  }
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    config.Router.webSearch
  ) {
    return config.Router.webSearch;
  }
  if (!config.Router.default) {
    throw new Error("Router.default configuration is missing. Please specify a default route in your config.json file.");
  }
  return config.Router.default;
};

export const router = async (req: any, _res: any, config: any) => {
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  try {
    // Validate payload shapes before tokenization to fail fast with context
    validateMessageShapes(messages as any[], system, tools as any[]);

    const tokenCount = calculateTokenCount(
      messages as MessageParam[],
      system,
      tools as Tool[]
    );

    let model;
    if (config.CUSTOM_ROUTER_PATH) {
      try {
        const customRouter = require(config.CUSTOM_ROUTER_PATH);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, config);
      } catch (e: any) {
        log("failed to load custom router", e.message);
      }
    }
    if (!model) {
      model = await getUseModel(req, tokenCount, config);
    }
    req.body.model = model;
  } catch (error: any) {
    log("Error in router middleware:", error.message);
    // Don't try to fallback if Router config is missing - just throw
    throw error;
  }
  
  return;
};
