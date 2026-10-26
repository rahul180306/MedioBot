import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Thread, Turn } from "./types/index.ts";
import { LocalDatabase } from "./storage/db.ts";
import { ChatRepository } from "./storage/chatRepository.ts";

export class LocalHistoryStore {
  private readonly chatRepo: ChatRepository;

  constructor(baseDirectory?: string, chatRepo?: ChatRepository) {
    if (chatRepo) {
      this.chatRepo = chatRepo;
    } else {
      const dbPath = baseDirectory ? path.join(baseDirectory, "mediobot.db") : undefined;
      const db = new LocalDatabase(dbPath);
      this.chatRepo = new ChatRepository(db.raw);
    }

    if (baseDirectory) {
      // Check for legacy .mediobot/history.json and migrate one-time if exists
      const legacyPath = path.join(baseDirectory, ".mediobot", "history.json");
      void this.migrateLegacyJson(legacyPath);
    }
  }

  private async migrateLegacyJson(filePath: string): Promise<void> {
    try {
      const data = await readFile(filePath, "utf8");
      const parsed = JSON.parse(data) as { threads?: Thread[] };
      if (parsed && Array.isArray(parsed.threads)) {
        for (const t of parsed.threads) {
          if (!this.chatRepo.get(t.id)) {
            this.chatRepo.save(t);
          }
        }
        await rm(filePath, { force: true }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  async list(workspaceId?: string | null): Promise<Thread[]> {
    return this.chatRepo.list(workspaceId);
  }

  async get(id: string): Promise<Thread | undefined> {
    return this.chatRepo.get(id) || undefined;
  }

  async save(thread: Thread): Promise<Thread> {
    return this.chatRepo.save(thread);
  }

  async saveMetadata(metadata: {
    id: string;
    title?: string;
    projectId?: string;
    model?: string;
    modelSelection?: Thread["modelSelection"];
    branch?: string;
    approvalMode?: string;
    createdAt?: number;
    updatedAt?: number;
  }): Promise<Thread> {
    return this.chatRepo.saveMetadata(metadata);
  }

  async delete(id: string): Promise<boolean> {
    return this.chatRepo.delete(id);
  }

  async updateTitle(id: string, title: string): Promise<boolean> {
    return this.chatRepo.updateTitle(id, title);
  }

  async appendTurn(threadId: string, turn: Turn, threadMeta?: Partial<Thread>): Promise<void> {
    let thread = this.chatRepo.get(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        title: threadMeta?.title || turn.prompt.slice(0, 40) || "New chat",
        projectId: threadMeta?.projectId || undefined,
        createdAt: threadMeta?.createdAt || Date.now(),
        updatedAt: Date.now(),
        model: threadMeta?.model || "Configured by local runtime",
        modelSelection: threadMeta?.modelSelection,
        branch: threadMeta?.branch || "main",
        approvalMode: threadMeta?.approvalMode || "Approve for me",
        turns: [turn],
      };
    } else {
      // A previously project-independent thread becomes project-scoped when its
      // first project execution is accepted. Existing project identity is only
      // changed by an explicit workspace migration/re-key operation.
      if (!thread.projectId && threadMeta?.projectId) thread.projectId = threadMeta.projectId;
      if (threadMeta?.modelSelection !== undefined) {
        thread.modelSelection = threadMeta.modelSelection;
      }
      if (threadMeta?.model !== undefined) {
        thread.model = threadMeta.model;
      }
      const existingTurnIdx = thread.turns.findIndex((t) => t.id === turn.id);
      if (existingTurnIdx >= 0) {
        thread.turns[existingTurnIdx] = turn;
      } else {
        thread.turns.push(turn);
      }
      thread.updatedAt = Date.now();
    }
    this.chatRepo.save(thread);
  }

  async updateTurn(threadId: string, turnId: string, updater: (turn: Turn) => void): Promise<void> {
    const thread = this.chatRepo.get(threadId);
    if (!thread) return;
    const turn = thread.turns.find((t) => t.id === turnId);
    if (!turn) return;
    updater(turn);
    thread.updatedAt = Date.now();
    this.chatRepo.save(thread);
  }

  async reconcileInterruptedTurns(): Promise<number> {
    return this.chatRepo.reconcileInterruptedTurns();
  }
}

