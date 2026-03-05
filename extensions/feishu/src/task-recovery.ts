import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { createFeishuClient } from "./client.js";
import { resolveFeishuAccount } from "./accounts.js";

export interface PendingTask {
  task: string;
  createdAt: string;
  context?: Record<string, unknown>;
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

// Send notification to user on startup about pending task
export async function notifyPendingTaskOnStartup(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  userOpenId?: string; // Optional: specific user to notify
}): Promise<void> {
  const pendingTask = getPendingTask();
  if (!pendingTask) {
    return;
  }

  // Use provided userOpenId or try to get from config
  const userOpenId = params.userOpenId;
  if (!userOpenId) {
    // No user to notify, just clear the task
    console.log("task-recovery: no userOpenId provided, clearing pending task");
    clearPendingTask();
    return;
  }

  try {
    const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!account.configured) {
      return;
    }

    const client = createFeishuClient(account);
    const messageText = `🔄 *任务恢复*\n\n我已重启上线。你有一个待恢复的任务：\n\n> ${pendingTask.task}\n\n（创建于 ${pendingTask.createdAt}）\n\n请告诉我继续执行或取消。`;

    await client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: userOpenId,
        msg_type: "text",
        content: JSON.stringify({ text: messageText }),
      },
    });
    console.log(`task-recovery: notified user ${userOpenId} about pending task`);
  } catch (err) {
    console.error("task-recovery: failed to notify user:", err);
  }
}
