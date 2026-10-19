import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { ASPECT_RATIOS } from "./constants";
import { executeCanvasTool, previewToolCall, toolNeedsUserApproval, type ToolRunContext } from "./applyTool";

const idList = (max: number) => z.array(z.string()).min(1).max(max);

export function canvasToolSet(ctx: ToolRunContext): ToolSet {
  const needs = (name: string) => (input: unknown) => toolNeedsUserApproval(name, input, ctx);
  const run = (name: string) => async (input: unknown) => {
    const result = executeCanvasTool(name, input, ctx);
    return result.observation;
  };
  return {
    canvas_overview: tool({
      description: "返回当前分集的紧凑索引：数量、选中、短 id 对照、类型、120 字预览、位置、是否有媒体、连线度。不返回全文和像素。",
      inputSchema: z.object({
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: run("canvas_overview"),
    }),
    read_cards: tool({
      description: "按真实 id 读取卡片全文、baseHash、生成记录和连线。写、删、提案之前必须先读目标。不要传入短 id。",
      inputSchema: z.object({ cardIds: idList(8) }),
      execute: run("read_cards"),
    }),
    search_cards: tool({
      description: "在卡片正文中搜索，返回真实 id 和匹配片段。画布超过一页时用它定位，不要假设只有前 40 张。",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        kind: z.enum(["text", "image", "video"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: run("search_cards"),
    }),
    create_cards: tool({
      description: "新建卡片。文字必须提供与张数相同的 texts，且分镜内容彼此不同。图片和视频只建容器，不生成媒体。超过本轮剩余 8 张额度时会先请求确认。",
      inputSchema: z.object({
        cardType: z.enum(["text", "image", "video"]),
        texts: z.array(z.string().max(12000)).max(12).optional(),
        count: z.number().int().min(1).max(12).optional(),
        referenceIds: z.array(z.string()).max(5).optional(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        allowSameText: z.boolean().optional(),
      }),
      needsApproval: needs("create_cards"),
      execute: run("create_cards"),
    }),
    update_text: tool({
      description: "逐张替换文字卡正文。每张都必须带 read_cards 返回的 baseHash。内容不一致时不会写入。",
      inputSchema: z.object({
        updates: z.array(z.object({
          cardId: z.string(),
          baseHash: z.string(),
          text: z.string().max(12000),
        })).min(1).max(8),
      }),
      needsApproval: needs("update_text"),
      execute: run("update_text"),
    }),
    move_cards: tool({
      description: "把卡片移动到绝对画布坐标。",
      inputSchema: z.object({
        moves: z.array(z.object({
          cardId: z.string(),
          x: z.number(),
          y: z.number(),
        })).min(1).max(40),
      }),
      needsApproval: needs("move_cards"),
      execute: run("move_cards"),
    }),
    arrange_cards: tool({
      description: "按 horizontal、vertical 或 grid 排列。grid 可用 columns（1 到 8）。",
      inputSchema: z.object({
        cardIds: idList(40),
        direction: z.enum(["horizontal", "vertical", "grid"]),
        columns: z.number().int().min(1).max(8).optional(),
      }),
      needsApproval: needs("arrange_cards"),
      execute: run("arrange_cards"),
    }),
    duplicate_cards: tool({
      description: "复制卡片和它们的连线。结果里返回新 id。",
      inputSchema: z.object({ cardIds: idList(12) }),
      needsApproval: needs("duplicate_cards"),
      execute: run("duplicate_cards"),
    }),
    delete_cards: tool({
      description: "删除卡片并去掉相关边。必须带 read_cards 的 baseHash。执行前需要用户确认，模型参数不能跳过确认。",
      inputSchema: z.object({
        cards: z.array(z.object({
          cardId: z.string(),
          baseHash: z.string(),
        })).min(1).max(40),
      }),
      needsApproval: needs("delete_cards"),
      execute: run("delete_cards"),
    }),
    connect_cards: tool({
      description: "建立 reference 或 sequence 边。引用规则与手动连线相同：文字只引用文字，图片可引用文字或图片，每张目标最多 5 条引用，视频不能作为引用。顺序边不参与图片参考。",
      inputSchema: z.object({
        links: z.array(z.object({
          sourceId: z.string(),
          targetId: z.string(),
          relation: z.enum(["reference", "sequence"]),
        })).min(1).max(20),
      }),
      needsApproval: needs("connect_cards"),
      execute: run("connect_cards"),
    }),
    disconnect_cards: tool({
      description: "按 sourceId、targetId 和可选 relation 断开连线。",
      inputSchema: z.object({
        links: z.array(z.object({
          sourceId: z.string(),
          targetId: z.string(),
          relation: z.enum(["reference", "sequence"]).optional(),
        })).min(1).max(20),
      }),
      needsApproval: needs("disconnect_cards"),
      execute: run("disconnect_cards"),
    }),
    select_cards: tool({
      description: "选中卡片。cardIds 为空表示清除选择。",
      inputSchema: z.object({ cardIds: z.array(z.string()).max(40).optional() }),
      execute: run("select_cards"),
    }),
    focus_viewport: tool({
      description: "把视口对准 cardIds，或用 fit all 看全画布。不修改卡片数据。",
      inputSchema: z.object({
        cardIds: z.array(z.string()).max(40).optional(),
        fit: z.literal("all").optional(),
      }),
      execute: run("focus_viewport"),
    }),
    propose_generation: tool({
      description: "记录一次尚未执行的图片或视频生成提案。P0 禁止调用图像和视频接口。必须带目标卡的 baseHash。",
      inputSchema: z.object({
        kind: z.enum(["image", "video"]),
        targetId: z.string(),
        baseHash: z.string(),
        prompt: z.string().min(1).max(3000),
        referenceIds: z.array(z.string()).max(5).optional(),
        aspectRatio: z.enum(ASPECT_RATIOS).optional(),
        resolution: z.enum(["1K", "2K"]).optional(),
        duration: z.union([z.literal(5), z.literal(10)]).optional(),
      }),
      needsApproval: needs("propose_generation"),
      execute: run("propose_generation"),
    }),
    finish: tool({
      description: "结束本轮并给出给用户看的总结。",
      inputSchema: z.object({ summary: z.string().min(1).max(1500) }),
      execute: run("finish"),
    }),
  };
}

export function describeCanvasTool(name: string, input: unknown) {
  return previewToolCall(name, input);
}
