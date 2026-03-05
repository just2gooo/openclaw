import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
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

// Send notification on startup and trigger task execution via handleFeishuMessage
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

  try {
    const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!account.configured) {
      return;
    }

    const client = createFeishuClient(account);

    // Determine where to send the message: use saved chatId or default to user
    const sendToId = pendingTask.chatId || userOpenId;
    const receiveIdType = (pendingTask.chatId && pendingTask.chatId.startsWith("oc_")) ? "chat_id" : "open_id";
    const chatType = pendingTask.chatType || (pendingTask.chatId?.startsWith("oc_") ? "group" : "p2p");

    const messageText = `✅ *已重启上线，任务自动继续*\n\n${pendingTask.task}\n\n（创建于 ${pendingTask.createdAt}）`;

    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: sendToId,
        msg_type: "text",
        content: JSON.stringify({ text: messageText }),
      },
    });

    log(`task-recovery: sent notification to ${sendToId}, now triggering task execution`);

    // Construct a synthetic message event to trigger agent to execute the task
    const taskContext = `\n\n[任务恢复] 你有一个待恢复的任务: "${pendingTask.task}" (创建于 ${pendingTask.createdAt})\n请继续执行这个任务，完成后删除待恢复任务。`;

    const messageEvent: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: pendingTask.senderOpenId || userOpenId,
        },
      },
      message: {
        message_id: `task-recovery-${Date.now()}`,
        chat_id: sendToId,
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: "任务自动继续" + taskContext }),
      },
    };

    // Clear the task now - it will be re-saved if execution fails
    clearPendingTask();

    // Trigger agent to execute the task
    await handleFeishuMessage({
      cfg: params.cfg,
      event: messageEvent,
      botOpenId: undefined,
      runtime: params.runtime,
      accountId: params.accountId,
    });

    log(`task-recovery: triggered task execution for: ${pendingTask.task}`);
  } catch (err) {
    log(`task-recovery: failed to auto-continue task: ${err}`);
  }
}
