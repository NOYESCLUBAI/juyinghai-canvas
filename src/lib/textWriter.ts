import { apiFetch } from "./apiClient";
import { modelRequest } from "./modelConfigs";
type ChatResponse = {
  text?: string;
  model?: string;
  message?: string;
  detail?: string;
};

type HealthResponse = {
  provider?: string;
  model?: string;
  models?: string[];
  configured?: boolean;
};

export type TextReference = {
  id: string;
  text: string;
};

function formatReferences(references: TextReference[]) {
  let remainingCharacters = 12000;

  const sections = references
    .slice(0, 5)
    .map((reference, index) => {
      const text = reference.text.trim();
      if (!text || remainingCharacters <= 0) {
        return "";
      }

      const excerpt = text.slice(0, Math.min(4000, remainingCharacters));
      remainingCharacters -= excerpt.length;
      return `[参考文字 ${index + 1}]\n${excerpt}`;
    })
    .filter(Boolean);

  return sections.length ? sections.join("\n\n") : "（未引用其他文字卡片）";
}

function buildWriterPrompt(
  instruction: string,
  currentText: string,
  references: TextReference[],
) {
  return `你是漫剧内容生成助手。请根据用户要求，生成一段可以直接作为当前文字卡片完整内容的中文文本。

要求：
- 只返回最终生成的正文。
- 不要解释写作过程，不要使用 Markdown 标题或代码块。
- 生成独立、完整的内容，不要默认续写或追加。
- 只有当用户明确要求续写、改写或修改时，才参考当前卡片内容。
- 如果用户要求与当前内容无关，直接按用户要求重新创作。
- 引用文字仅作为人物、世界观、情节和语气参考，不要在结果中提及“参考文字”。

当前卡片内容（仅供必要时参考）：
${currentText.slice(0, 12000) || "（空白卡片）"}

用户主动引用的其他文字卡片：
${formatReferences(references)}

用户要求：
${instruction.slice(0, 3000)}`;
}

function buildSelectionRewritePrompt(
  instruction: string,
  selection: {
    text: string;
    before: string;
    after: string;
  },
  references: TextReference[],
) {
  return `你是漫剧剧本的局部文字编辑助手。请严格按照用户要求，只改写“选中的原文”。

要求：
- 只返回用于替换选区的新文字。
- 不要解释修改过程，不要加引号、前缀、后缀或代码块。
- 不要重复选区外的前文和后文。
- 保持与前后文的人物、语气、时态和情节连贯。
- 除非用户明确要求，否则不要添加 Markdown 标题或列表符号。
- 引用文字仅作为人物、世界观、情节和语气参考，不要在结果中提及“参考文字”。

选区前文：
${selection.before.slice(-4000) || "（无）"}

选中的原文：
${selection.text.slice(0, 8000)}

选区后文：
${selection.after.slice(0, 4000) || "（无）"}

用户主动引用的其他文字卡片：
${formatReferences(references)}

用户的改写要求：
${instruction.slice(0, 3000)}`;
}

async function requestTextModel(prompt: string, model: string) {
  const response = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, ...modelRequest("text", model) }),
  });
  const data = (await response.json().catch(() => null)) as ChatResponse | null;

  if (!response.ok || !data?.text?.trim()) {
    throw new Error(
      data?.message || data?.detail || `文本模型返回 ${response.status}`,
    );
  }

  return {
    text: data.text.trim(),
    model: data.model?.trim() || "文本模型",
  };
}

export async function generateTextForCard(
  instruction: string,
  currentText: string,
  model: string,
  references: TextReference[] = [],
) {
  return requestTextModel(
    buildWriterPrompt(instruction, currentText, references),
    model,
  );
}

export async function rewriteTextSelection(
  instruction: string,
  selection: {
    text: string;
    before: string;
    after: string;
  },
  model: string,
  references: TextReference[] = [],
) {
  return requestTextModel(
    buildSelectionRewritePrompt(instruction, selection, references),
    model,
  );
}

export async function readTextModelOptions() {
  const response = await apiFetch("/api/health");
  if (!response.ok) {
    throw new Error("无法读取文本模型");
  }

  const data = (await response.json()) as HealthResponse;
  const defaultModel = data.model?.trim() || "agnes-3.0-flash";
  const configuredModels = (data.models || [])
    .map((model) => model.trim())
    .filter(Boolean);
  const models = Array.from(new Set([defaultModel, ...configuredModels]));

  return {
    defaultModel,
    models,
    provider: data.provider?.trim() || "Agnes AI",
    configured: Boolean(data.configured),
  };
}
