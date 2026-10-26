import type { MediobotDefinitionId, TaskId, WorkerId } from "@mediobot-v2/domain";
import type { AppendCollaborationGroupMessageInput, SpecialistMessagePayload, SpecialistMessageRecord } from "@mediobot-v2/contracts";
import { COLLABORATION_GROUP_CONTEXT_MAX_CHARS, COLLABORATION_GROUP_CONTEXT_MAX_MESSAGES, COLLABORATION_GROUP_MESSAGE_MAX_CHARS } from "@mediobot-v2/contracts";
import type { DurableTaskEngine, SpecialistCommunicationPort, SpecialistSessionAccess } from "@mediobot-v2/runtime";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";

export interface SpecialistCommunicationEvent {
  readonly parentTaskId: TaskId;
  readonly executionTaskId: TaskId;
  readonly workerId: WorkerId;
  readonly senderSpecialistId: MediobotDefinitionId;
  readonly recipientSpecialistId: MediobotDefinitionId;
  readonly scope?: "direct" | "group";
  readonly groupId?: string;
  readonly messageKind?: SpecialistMessagePayload["kind"];
  readonly messageId: string;
  readonly sequenceNumber: number;
  readonly status: "sent" | "delivered" | "failed" | "cancelled" | "timed_out";
}

const MAX_MESSAGES_PER_TASK = 12;
const MAX_MESSAGES_PER_SPECIALIST = 6;
const MAX_TEXT_CHARS = 2_000;
const MAX_INJECTED_CHARS = 4_000;
const MAX_INJECTED_MESSAGES = 6;
const MAX_WAIT_MS = 2_000;
const MAX_REPLY_WAIT_MS = 1_500;
const POLL_INTERVAL_MS = 75;
const MAX_OPEN_REQUESTS = 2;
const MAX_REQUESTS_PER_SPECIALIST = 2;

function decode(record: SpecialistMessageRecord): SpecialistMessagePayload | undefined {
  try {
    const value = JSON.parse(record.content) as Record<string, unknown>;
    if (value.version !== 1 || !["request", "response", "finding"].includes(String(value.kind))
      || typeof value.correlationId !== "string" || typeof value.text !== "string" || value.text.length > MAX_TEXT_CHARS) return undefined;
    if (value.kind === "response" && typeof value.inReplyTo !== "string") return undefined;
    const text = sanitizeReasoningAndSecrets(value.text).slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) return undefined;
    return { ...value, text } as SpecialistMessagePayload;
  } catch { return undefined; }
}

export class SpecialistCommunicationHub {
  private readonly engine: DurableTaskEngine;
  private readonly parentTaskId: TaskId;
  private readonly accesses = new Map<MediobotDefinitionId, SpecialistSessionAccess>();
  private readonly opened = new Set<MediobotDefinitionId>();
  private readonly delegationIds: string[] = [];
  private readonly workerContexts = new Map<MediobotDefinitionId, { taskId: TaskId; workerId: WorkerId }>();
  private readonly participants: Set<MediobotDefinitionId>;
  private readonly names: Map<MediobotDefinitionId, string>;
  private readonly onEvent?: (event: SpecialistCommunicationEvent) => void;
  private totalMessages = 0;
  private readonly senderCounts = new Map<MediobotDefinitionId, number>();
  private readonly fingerprints = new Set<string>();
  private readonly receivedRequests = new Set<MediobotDefinitionId>();
  private readonly sentRequests = new Map<string, { sender: MediobotDefinitionId; recipient: MediobotDefinitionId; messageId: string }>();
  private readonly requestCounts = new Map<MediobotDefinitionId, number>();
  private stopped = false;
  groupId: string;
  private coordinatorAccess?: SpecialistSessionAccess;

  private constructor(engine: DurableTaskEngine, parentTaskId: TaskId, participants: ReadonlyArray<MediobotDefinitionId>,
    onEvent?: (event: SpecialistCommunicationEvent) => void, names: ReadonlyMap<MediobotDefinitionId, string> = new Map(), groupId = "") {
    this.engine = engine;
    this.parentTaskId = parentTaskId;
    this.participants = new Set(participants);
    this.names = new Map(names);
    this.onEvent = onEvent;
    this.groupId = groupId;
  }

  static async create(engine: DurableTaskEngine, parentTaskId: TaskId, participants: ReadonlyArray<MediobotDefinitionId>,
    onEvent?: (event: SpecialistCommunicationEvent) => void, names: ReadonlyMap<MediobotDefinitionId, string> = new Map()): Promise<SpecialistCommunicationHub | undefined> {
    const parent = await engine.getTask(parentTaskId);
    if (!parent?.threadId || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) return undefined;
    const unique = [...new Set(participants)];
    if (!unique.some(specialistId => specialistId !== parent.definitionId)) return undefined;
    const hub = new SpecialistCommunicationHub(engine, parentTaskId, unique, onEvent, names);
    const rows = await engine.getDelegations(parentTaskId);
    for (const specialistId of unique) {
      if (specialistId === parent.definitionId) continue;
      const existing = rows.find(row => row.assignedMediobotId === specialistId && row.status === "active");
      if (existing) { hub.delegationIds.push(existing.id); continue; }
      const name = specialistId;
      const delegation = await engine.recordDelegation(parentTaskId, { parentTaskId, childTaskId: null, assignedMediobotId: specialistId,
        assignedMediobotName: name, objective: "Authorized participant in bounded specialist collaboration", status: "active" });
      hub?.delegationIds.push(delegation.id);
    }
    for (const specialistId of unique) {
      const access = await engine.authorizeSpecialistSessionScope(parentTaskId, specialistId);
      await engine.getOrCreateSpecialistSession(access);
      hub.accesses.set(specialistId, access);
    }
    const group = await engine.createCollaborationGroup(parentTaskId, unique);
    hub.groupId = group.id;
    const coordinatorAccess = await engine.authorizeSpecialistSessionScope(parentTaskId, parent.definitionId as MediobotDefinitionId);
    hub.coordinatorAccess = coordinatorAccess;
    await engine.getOrCreateSpecialistSession(coordinatorAccess);
    // Restore only members explicitly persisted in this group. A delegation by
    // itself never opts a private specialist conversation into shared history.
    for (const member of await engine.getCollaborationGroupMembers(coordinatorAccess, group.id)) {
      if (member.role === "coordinator" || hub.accesses.has(member.specialistId)) continue;
      const memberDelegation = rows.find(item => item.assignedMediobotId === member.specialistId && item.status === "active");
      if (!memberDelegation) throw new Error("Persisted collaboration member has no active parent-task authorization.");
      const memberAccess = await engine.authorizeSpecialistSessionScope(parentTaskId, member.specialistId);
      await engine.getOrCreateSpecialistSession(memberAccess);
      hub.accesses.set(member.specialistId, memberAccess);
      hub.participants.add(member.specialistId);
      hub.names.set(member.specialistId, names.get(member.specialistId) ?? member.specialistId);
      hub.delegationIds.push(memberDelegation.id);
    }
    await engine.publishCollaborationGroupMessage(coordinatorAccess, group.id, { kind: "finding", idempotencyKey: `${group.id}:objective`,
      content: sanitizeReasoningAndSecrets(`Shared task objective: ${parent.goal}`).slice(0, COLLABORATION_GROUP_MESSAGE_MAX_CHARS), evidenceRefs: [] });
    const seen = new Set<string>();
    const answered = new Set<string>();
    for (const access of hub.accesses.values()) for (const record of await engine.getSpecialistMessages(access, { limit: 100 })) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      hub.totalMessages += 1;
      hub.senderCounts.set(record.senderSpecialistId, (hub.senderCounts.get(record.senderSpecialistId) ?? 0) + 1);
      const payload = decode(record);
      if (payload?.kind === "request") {
        hub.requestCounts.set(record.senderSpecialistId, (hub.requestCounts.get(record.senderSpecialistId) ?? 0) + 1);
        hub.fingerprints.add(`${record.senderSpecialistId}\0${record.recipientSpecialistId}\0request\0${payload.text.trim().toLowerCase()}`);
        if (record.deliveryStatus === "pending" || record.deliveryStatus === "delivered") {
          hub.sentRequests.set(payload.correlationId, { sender: record.senderSpecialistId, recipient: record.recipientSpecialistId, messageId: record.id });
        }
      } else if (payload?.kind === "response" && record.deliveryStatus === "delivered") {
        answered.add(payload.correlationId);
      } else if (payload?.kind === "finding") {
        hub.fingerprints.add(`${record.senderSpecialistId}\0${record.recipientSpecialistId}\0finding\0${payload.text.trim().toLowerCase()}`);
      }
    }
    for (const event of await engine.getEvents(parentTaskId)) if (event.eventType === "specialist.message.request_timeout"
      && typeof event.payload.correlationId === "string") answered.add(event.payload.correlationId);
    for (const correlationId of answered) hub.sentRequests.delete(correlationId);
    return hub;
  }

  /** Maestro-only runtime expansion hook; durable storage rechecks task assignment before admitting the member. */
  async addAuthorizedParticipant(specialistId: MediobotDefinitionId, name: string): Promise<void> {
    if (this.stopped || !this.coordinatorAccess || !this.groupId) throw new Error("Collaboration is not active.");
    if (this.participants.has(specialistId)) return;
    await this.engine.addCollaborationGroupMember(this.coordinatorAccess, this.groupId, specialistId);
    const delegation = (await this.engine.getDelegations(this.parentTaskId)).find(item =>
      item.assignedMediobotId === specialistId && item.status === "active");
    if (!delegation) throw new Error("Authorized group member has no active task delegation.");
    const access = await this.engine.authorizeSpecialistSessionScope(this.parentTaskId, specialistId);
    await this.engine.getOrCreateSpecialistSession(access);
    this.accesses.set(specialistId, access);
    this.participants.add(specialistId);
    this.names.set(specialistId, name);
    this.delegationIds.push(delegation.id);
  }

  async readCoordinatorHistory(): Promise<ReadonlyArray<{ sequenceNumber: number; senderSpecialistId: MediobotDefinitionId; kind: "finding" | "request"; content: string; evidenceRefs: ReadonlyArray<string> }>> {
    if (!this.coordinatorAccess || !this.groupId) return [];
    const result = await this.engine.receiveCollaborationGroupMessages(this.coordinatorAccess, this.groupId,
      COLLABORATION_GROUP_CONTEXT_MAX_MESSAGES, COLLABORATION_GROUP_CONTEXT_MAX_CHARS);
    return result.messages.map(message => ({ sequenceNumber: message.sequenceNumber, senderSpecialistId: message.senderSpecialistId,
      kind: message.kind, content: message.content, evidenceRefs: message.evidenceRefs }));
  }

  open(specialistId: MediobotDefinitionId, executionTaskId: TaskId, workerId: WorkerId): SpecialistCommunicationPort {
    if (!this.participants.has(specialistId) || !this.accesses.has(specialistId)) throw new Error("Specialist is not authorized for this collaboration.");
    if (this.opened.has(specialistId)) throw new Error("A specialist may have only one active collaboration worker per parent task.");
    this.opened.add(specialistId);
    this.workerContexts.set(specialistId, { taskId: executionTaskId, workerId });
    const access = this.accesses.get(specialistId)!;
    const hub = this;
    const sentRequests = this.sentRequests;
    const receivedRequests = this.receivedRequests;
    let cursor = 0;
    let injectedChars = 0;
    let injectedMessages = 0;
    const buffered: Array<{ record: SpecialistMessageRecord; payload: SpecialistMessagePayload }> = [];
    let groupInjectedChars = 0;
    let groupInjectedMessages = 0;
    const emit = (record: SpecialistMessageRecord, status: SpecialistCommunicationEvent["status"]) => {
      try { this.onEvent?.({ parentTaskId: this.parentTaskId, executionTaskId, workerId, senderSpecialistId: record.senderSpecialistId,
        recipientSpecialistId: record.recipientSpecialistId, messageKind: decode(record)?.kind, messageId: record.id,
        scope: "direct", sequenceNumber: record.sequenceNumber, status }); } catch { /* event observers are non-authoritative */ }
    };
    const send = async (recipient: MediobotDefinitionId, payload: SpecialistMessagePayload, evidenceRefs: ReadonlyArray<string> = [], signal?: AbortSignal) => {
      if (this.stopped) throw new Error("Collaboration has stopped.");
      signal?.throwIfAborted();
      if (!this.participants.has(recipient) || recipient === specialistId) throw new Error("Recipient is not an authorized collaboration peer.");
      const cleanText = sanitizeReasoningAndSecrets(payload.text).slice(0, MAX_TEXT_CHARS);
      if (!cleanText.trim() || cleanText.length > MAX_TEXT_CHARS) throw new Error("Specialist message exceeds the communication bound.");
      payload = { ...payload, text: cleanText };
      if (this.totalMessages >= MAX_MESSAGES_PER_TASK || (this.senderCounts.get(specialistId) ?? 0) >= MAX_MESSAGES_PER_SPECIALIST) {
        throw new Error("Specialist communication budget exhausted.");
      }
      const fingerprint = `${specialistId}\0${recipient}\0${payload.kind}\0${payload.text.trim().toLowerCase()}`;
      if (payload.kind !== "response" && this.fingerprints.has(fingerprint)) throw new Error("Repeated specialist message rejected.");
      const result = await this.engine.appendSpecialistMessage(access, { recipientSpecialistId: recipient,
        idempotencyKey: `${this.parentTaskId}:${specialistId}:${recipient}:${payload.correlationId}:${payload.kind}`,
        content: JSON.stringify(payload), evidenceRefs: [...new Set(evidenceRefs)].slice(0, 8) });
      if (!result.isDuplicate) {
        this.totalMessages += 1;
        this.senderCounts.set(specialistId, (this.senderCounts.get(specialistId) ?? 0) + 1);
        if (payload.kind !== "response") this.fingerprints.add(fingerprint);
        if (payload.kind === "request") {
          hub.requestCounts.set(specialistId, (hub.requestCounts.get(specialistId) ?? 0) + 1);
          this.sentRequests.set(payload.correlationId, { sender: specialistId, recipient, messageId: result.message.id });
        }
      }
      if (!result.isDuplicate) emit(result.message, "sent");
      return result.message;
    };
    const poll = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const records = await this.engine.getSpecialistMessages(access, { afterSequence: cursor, limit: 8 });
      const received: Array<{ record: SpecialistMessageRecord; payload: SpecialistMessagePayload }> = buffered.splice(0, buffered.length);
      for (const record of records) {
        if (record.deliveryStatus !== "pending") {
          cursor = Math.max(cursor, record.sequenceNumber);
          continue;
        }
        const payload = decode(record);
        if (!payload || injectedChars + payload.text.length > MAX_INJECTED_CHARS || injectedMessages >= MAX_INJECTED_MESSAGES) {
          const failed = await this.engine.updateSpecialistMessageStatus(access, record.id, "failed");
          cursor = Math.max(cursor, record.sequenceNumber);
          emit(failed, "failed");
          continue;
        }
        if (payload.kind === "request") this.receivedRequests.add(specialistId);
        if (payload.kind === "response") {
          const request = this.sentRequests.get(payload.correlationId);
          if (!request || request.sender !== specialistId || request.recipient !== record.senderSpecialistId || request.messageId !== payload.inReplyTo) {
            const failed = await this.engine.updateSpecialistMessageStatus(access, record.id, "failed");
            cursor = Math.max(cursor, record.sequenceNumber);
            emit(failed, "failed");
            continue;
          }
        }
        const delivered = await this.engine.updateSpecialistMessageStatus(access, record.id, "delivered");
        cursor = Math.max(cursor, record.sequenceNumber);
        injectedChars += payload.text.length;
        injectedMessages += 1;
        if (payload.kind === "response") this.sentRequests.delete(payload.correlationId);
        const item = { record: delivered, payload };
        if (payload.kind === "response") received.push(item); else received.push(item);
        emit(delivered, "delivered");
      }
      return received;
    };
    return {
      authorizedRecipients: [...this.participants].filter(id => id !== specialistId).map(id => ({ id,
        name: this.names.get(id) ?? id })),
      async sendRequest(recipient, text, signal, evidenceRefs = []) {
        if (receivedRequests.has(specialistId)) throw new Error("Communication depth limit reached; answer the incoming request instead of opening a request chain.");
        if ((hub.requestCounts.get(specialistId) ?? 0) >= MAX_REQUESTS_PER_SPECIALIST) throw new Error("Specialist request budget exhausted; proceed with available evidence or report the unresolved dependency.");
        if ([...sentRequests.values()].filter(r => r.sender === specialistId).length >= MAX_OPEN_REQUESTS) throw new Error("Open specialist request limit reached.");
        const correlationId = globalThis.crypto.randomUUID();
        const request = await send(recipient, { version: 1, kind: "request", correlationId, text: text.slice(0, MAX_TEXT_CHARS) }, evidenceRefs, signal);
        const deadline = Date.now() + MAX_WAIT_MS;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          const messages = await poll(signal);
          const response = messages.find(item => item.payload.kind === "response" && item.payload.correlationId === correlationId);
          for (const message of messages) if (message !== response) buffered.push(message);
          if (response) return response.payload.text;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
            const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Cancelled")); };
            signal.addEventListener("abort", abort, { once: true });
          });
        }
        sentRequests.delete(correlationId);
        try {
          const recipientAccess = hub.accesses.get(recipient);
          const status = recipientAccess ? (await hub.engine.getSpecialistMessages(recipientAccess)).find(message => message.id === request.id)?.deliveryStatus : undefined;
          if (status === "pending" && recipientAccess) await hub.engine.updateSpecialistMessageStatus(recipientAccess, request.id, "failed");
          await hub.engine.appendEvent(hub.parentTaskId, "specialist.message.request_timeout", { messageId: request.id, correlationId });
        } catch { /* cancellation or task finalization may already have closed the request */ }
        emit(request, "timed_out");
        return undefined;
      },
      async sendFinding(recipient, text, evidenceRefs = [], signal) {
        await send(recipient, { version: 1, kind: "finding", correlationId: globalThis.crypto.randomUUID(), text: text.slice(0, MAX_TEXT_CHARS) }, evidenceRefs, signal);
      },
      async receive(signal) { return poll(signal); },
      groupId: hub.groupId,
      async publishGroupMessage(input: AppendCollaborationGroupMessageInput, signal?: AbortSignal) {
        if (hub.stopped) throw new Error("Collaboration has stopped.");
        signal?.throwIfAborted();
        const content = sanitizeReasoningAndSecrets(input.content).slice(0, COLLABORATION_GROUP_MESSAGE_MAX_CHARS);
        if (!content.trim() || input.content.length > COLLABORATION_GROUP_MESSAGE_MAX_CHARS) throw new Error("Group message exceeds the communication bound.");
        const result = await hub.engine.publishCollaborationGroupMessage(access, hub.groupId, { ...input, content,
          evidenceRefs: [...new Set(input.evidenceRefs)].slice(0, 8) });
        if (!result.isDuplicate) {
          try { hub.onEvent?.({ parentTaskId: hub.parentTaskId, executionTaskId, workerId, senderSpecialistId: specialistId,
            recipientSpecialistId: specialistId, scope: "group", groupId: hub.groupId, messageKind: input.kind,
            messageId: result.message.id, sequenceNumber: result.message.sequenceNumber, status: "sent" }); } catch { /* observers do not control delivery */ }
        }
        return result.message;
      },
      async receiveGroup(signal) {
        signal.throwIfAborted();
        if (groupInjectedMessages >= COLLABORATION_GROUP_CONTEXT_MAX_MESSAGES || groupInjectedChars >= COLLABORATION_GROUP_CONTEXT_MAX_CHARS) {
          return { messages: [], readSequenceNumber: (await hub.engine.getCollaborationGroupMembers(access, hub.groupId)).find(member => member.specialistId === specialistId)?.readSequenceNumber ?? 0 };
        }
        const result = await hub.engine.receiveCollaborationGroupMessages(access, hub.groupId,
          COLLABORATION_GROUP_CONTEXT_MAX_MESSAGES - groupInjectedMessages, COLLABORATION_GROUP_CONTEXT_MAX_CHARS - groupInjectedChars);
        for (const message of result.messages) {
          groupInjectedMessages += 1; groupInjectedChars += message.content.length;
          try { hub.onEvent?.({ parentTaskId: hub.parentTaskId, executionTaskId, workerId, senderSpecialistId: message.senderSpecialistId,
            recipientSpecialistId: specialistId, scope: "group", groupId: hub.groupId, messageKind: message.kind,
            messageId: message.id, sequenceNumber: message.sequenceNumber, status: "delivered" }); } catch { /* observers do not control delivery */ }
        }
        return { messages: result.messages, readSequenceNumber: result.readSequenceNumber };
      },
      async respond(message, text, evidenceRefs = [], signal) {
        const payload = decode(message);
        if (!payload || payload.kind !== "request" || message.recipientSpecialistId !== specialistId) throw new Error("Only an assigned request can be answered.");
        await send(message.senderSpecialistId, { version: 1, kind: "response", correlationId: payload.correlationId, inReplyTo: message.id, text: text.slice(0, MAX_TEXT_CHARS) }, evidenceRefs, signal);
      },
    };
  }

  closeWorker(specialistId: MediobotDefinitionId, executionTaskId: TaskId): void {
    const current = this.workerContexts.get(specialistId);
    if (!current || current.taskId !== executionTaskId) return;
    this.opened.delete(specialistId);
    this.workerContexts.delete(specialistId);
  }

  async close(status: "completed" | "failed" | "cancelled" = "completed"): Promise<void> {
    this.stopped = true;
    if (status === "cancelled") await this.engine.closeCollaborationGroup(this.parentTaskId, "cancelled").catch(() => undefined);
    if (status === "cancelled") {
      const emitted = new Set<string>();
      for (const [specialistId, access] of this.accesses) for (const message of await this.engine.getSpecialistMessages(access).catch(() => [])) {
        if (message.deliveryStatus !== "cancelled" || emitted.has(message.id)) continue;
        emitted.add(message.id);
        const context = this.workerContexts.get(message.senderSpecialistId) ?? this.workerContexts.get(specialistId);
        if (context) {
          try { this.onEvent?.({ parentTaskId: this.parentTaskId, executionTaskId: context.taskId, workerId: context.workerId,
            senderSpecialistId: message.senderSpecialistId, recipientSpecialistId: message.recipientSpecialistId, messageKind: decode(message)?.kind,
            messageId: message.id, sequenceNumber: message.sequenceNumber, status: "cancelled" }); } catch { /* observers do not control cancellation */ }
        }
      }
    }
    for (const id of this.delegationIds) {
      try { await this.engine.updateDelegation(id, { status }); } catch { /* task cancellation or restart may have finalized it */ }
    }
  }
}

/** Handles at most two requests while an assignment is active; each answer uses the specialist's existing model client. */
export interface ReceivedSpecialistFinding {
  readonly senderSpecialistId: MediobotDefinitionId;
  readonly kind?: "finding" | "request";
  readonly scope?: "direct" | "group";
  readonly text: string;
  readonly evidenceRefs: ReadonlyArray<string>;
}

export function startSpecialistRequestResponder(port: SpecialistCommunicationPort | undefined, signal: AbortSignal,
  answer: (request: string, message: SpecialistMessageRecord, signal: AbortSignal) => Promise<string>): () => Promise<ReadonlyArray<ReceivedSpecialistFinding>> {
  if (!port) return async () => [];
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  let handled = 0;
  let stopping = false;
  const findings: ReceivedSpecialistFinding[] = [];
  const loop = (async () => {
    while (!stopping && !controller.signal.aborted) {
      try {
        const incoming = await port.receive(controller.signal);
        for (const item of incoming) {
          if (item.payload.kind === "finding") {
            findings.push({ senderSpecialistId: item.record.senderSpecialistId,
              text: item.payload.text.slice(0, MAX_TEXT_CHARS), evidenceRefs: item.record.evidenceRefs.slice(0, 8) });
            continue;
          }
          if (item.payload.kind !== "request") continue;
          let response = "I could not verify this request from the evidence available in my assignment.";
          if (handled < 2) {
            handled += 1;
            const responseController = new AbortController();
            const cancelResponse = () => responseController.abort(controller.signal.reason);
            controller.signal.addEventListener("abort", cancelResponse, { once: true });
            const timeout = setTimeout(() => responseController.abort(new Error("Specialist response timed out")), MAX_REPLY_WAIT_MS);
            try { response = (await answer(item.payload.text.slice(0, MAX_TEXT_CHARS), item.record, responseController.signal)).trim().slice(0, MAX_TEXT_CHARS) || response; }
            catch { if (controller.signal.aborted) return; }
            finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", cancelResponse); }
          }
          controller.signal.throwIfAborted();
          await port.respond(item.record, response, item.record.evidenceRefs, controller.signal);
        }
        if (port.receiveGroup) {
          const shared = await port.receiveGroup(controller.signal);
          for (const message of shared.messages) findings.push({ senderSpecialistId: message.senderSpecialistId,
            kind: message.kind, scope: "group", text: message.content.slice(0, COLLABORATION_GROUP_MESSAGE_MAX_CHARS), evidenceRefs: message.evidenceRefs.slice(0, 8) });
        }
        await new Promise<void>(resolve => {
          setTimeout(resolve, POLL_INTERVAL_MS);
        });
      } catch {
        if (controller.signal.aborted) return;
        await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  })();
  return async () => {
    stopping = true;
    signal.removeEventListener("abort", cancel);
    await loop;
    return findings;
  };
}
