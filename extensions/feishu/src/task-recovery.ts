import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "crypto";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import { createFeishuClient } from "./client.js";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";

export interface PendingTask {
  task: string;
  createdAt: string;
  context?: Record<string, unknown>;
  // For auto-recovery after restart
  chatId?: string;
  chatType?: "p2p" | "group";
  senderOpenId?: string;
}

const TASK_FILE = path.join(os.homedir(), ".openclaw", "workspace", "memory", "pending-task.json");

export function savePendingTask(task: PendingTask): void {
  const dir = path.dirname(TASK_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TASK_FILE, JSON.stringify(task, null, 2));
}

export function getPendingTask(): PendingTask | null {
  try {
    if (!fs.existsSync(TASK_FILE)) {
      return null;
    }
    const content = fs.readFileSync(TASK_FILE, "utf-8");
    const task = JSON.parse(content) as PendingTask;
    return task.task ? task : null;
  } catch {
    return null;
  }
}

export function clearPendingTask(): void {
  try {
    if (fs.existsSync(TASK_FILE)) {
      fs.unlinkSync(TASK_FILE);
    }
  } catch {
    // Ignore errors
  }
}

// Send notification on startup and trigger agent to continue the task
export async function notifyAndContinueTaskOnStartup(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  userOpenId?: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const pendingTask = getPendingTask();
  if (!pendingTask) {
    return;
  }

  const userOpenId = params.userOpenId;
  if (!userOpenId) {
    console.log("task-recovery: no userOpenId, skipping notification");
    return;
  }

  const log = params.runtime?.log ?? console.log;
  const chatHistories = new Map<string, HistoryEntry[]>();

  try {
    const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!account.configured) {
      return;
    }

    const client = createFeishuClient(account);

    // Determine where to send the message: use saved chatId or default to user
    const sendToId = pendingTask.chatId || userOpenId;
    const receiveIdType = (pendingTask.chatId && pendingTask.chatId.startsWith("oc_")) ? "chat_id" : "open_id";

    const messageText = `✅ *已重启上线，任务自动继续*\n\n${pendingTask.task}\n\n（创建于 ${pendingTask.createdAt}）`;

    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: sendToId,
        msg_type: "text",
        content: JSON.stringify({ text: messageText }),
      },
    });

    log(`task-recovery: sent notification to ${sendToId}`);

    // Create a synthetic message event to trigger the agent
    // This simulates the user sending a message to continue the task
    const syntheticEvent: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: pendingTask.senderOpenId || userOpenId,
        },
        sender_type: "user",
      },
      message: {
        // Use a unique message_id that won't conflict with real messages
        message_id: `task-recovery:${crypto.randomUUID()}`,
        chat_id: sendToId,
        chat_type: pendingTask.chatType || "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: `[任务恢复] 继续执行之前未完成的任务: ${pendingTask.task}`,
        }),
        create_time: Date.now().toString(),
      },
    };

    log(`task-recovery: triggering agent with synthetic event`);

    // Call handleFeishuMessage to trigger the agent to continue the task
    await handleFeishuMessage({
      cfg: params.cfg,
      event: syntheticEvent,
      botOpenId: undefined,
      runtime: params.runtime,
      chatHistories,
      accountId: params.accountId,
    });

    log(`task-recovery: agent triggered successfully`);
  } catch (err) {
    log(`task-recovery: failed to send notification or trigger agent: ${err}`);
  }
}
