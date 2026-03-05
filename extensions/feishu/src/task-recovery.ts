import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
