import { cloneServerConfig, type ServerConfig } from "../../models/config";
import type { InventoryOperationContext, InventorySourceConfig, InventorySourceValues } from "../../models/inventory";
import type { NexusCore, InventorySourceMutation, InventorySourceMutationPreparation } from "../../core/nexusCore";
import {
  assertInventorySourceDependenciesCurrent,
  snapshotInventorySourceDependencies,
  type InventorySourceDependencySnapshot
} from "./inventorySourceDependencies";
import type {
  ContainerlabRuntime,
  ContainerlabExecutionIdentity,
  ContainerlabExecutor,
  ContainerlabRunContext
} from "./containerlabRuntimeContracts";
import { parseContainerlabConfig, type ContainerlabConfig } from "./providers/containerlabConfig";

const RUN_DEADLINE_MS = 30_000;
const APPROVAL_SCHEMA = 1;

export interface ContainerlabApprovalStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export interface ContainerlabActivationController extends ContainerlabRuntime {
  beginFormSession(editOrigin?: { readonly sourceId: string; readonly revision: string }): string;
  updateFormSession(sessionId: string, values: InventorySourceValues): void;
  endFormSession(sessionId: string): void;
  prepareFormSourceSave(sessionId: string, sourceId: string): () => void;
  invalidateSource(sourceId: string): Promise<void>;
  invalidateAllSources(): Promise<void>;
  transferFormApproval(sessionId: string, source: InventorySourceConfig): Promise<void>;
  dispose(): void;
}

export interface ContainerlabActivationDependencies {
  readonly core: NexusCore;
  readonly executor: ContainerlabExecutor;
  readonly store: ContainerlabApprovalStore;
  readonly isWorkspaceTrusted: () => boolean;
  readonly confirmRun: (description: string) => Promise<boolean>;
  readonly createId?: () => string;
  readonly now?: () => number;
}

interface ApprovalRecord {
  readonly scope: "source" | "form";
  readonly id: string;
  readonly generation: string;
  readonly acceptedRevision?: string;
  readonly intentKey: string;
  readonly dependencyIdentity: string | null;
  readonly executionIdentity: ContainerlabExecutionIdentity;
}

interface StoredApprovalDocument {
  readonly schema: number;
  readonly sessionNonce: string;
  readonly records: readonly ApprovalRecord[];
}

interface FormSession {
  readonly id: string;
  generation: string;
  readonly editOrigin?: { readonly sourceId: string; readonly revision: string };
  values?: InventorySourceValues;
  approval?: ApprovalRecord;
}

interface FormSaveAssociation {
  readonly token: string;
  readonly sessionId: string;
  readonly formGeneration: string;
  readonly sourceId: string;
  readonly expectedPreviousRevision?: string;
  readonly intentKey: string;
  readonly dependencyIdentity: string | null;
  readonly executionIdentity: ContainerlabExecutionIdentity;
}

interface PendingTransfer extends FormSaveAssociation {
  readonly sourceGeneration: string;
  readonly acceptedRevision: string;
}

interface OperationCapture {
  readonly intent: InventoryOperationContext["intent"];
  readonly source?: InventorySourceConfig;
  readonly form?: FormSession;
  readonly formGeneration?: string;
  readonly sourceGeneration?: string;
  readonly config: ContainerlabConfig;
  readonly intentKey: string;
  readonly dependencies?: InventorySourceDependencySnapshot;
  readonly dependencyIdentity: string | null;
  readonly labHost?: ServerConfig;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function intentKey(providerId: string, values: InventorySourceValues): string {
  return stableJson({ providerId, values });
}

function cloneValues(values: InventorySourceValues): InventorySourceValues {
  return structuredClone(values);
}

function cloneExecutionIdentity(identity: ContainerlabExecutionIdentity): ContainerlabExecutionIdentity {
  return {
    executable: identity.executable,
    dockerExecutable: identity.dockerExecutable,
    ...(identity.imageId !== undefined ? { imageId: identity.imageId } : {}),
    ...(identity.containerId !== undefined ? { containerId: identity.containerId } : {}),
    dockerSocket: identity.dockerSocket,
    location: identity.location,
    sudo: identity.sudo,
    routeIdentity: identity.routeIdentity
  };
}

function executionIdentityEqual(a: ContainerlabExecutionIdentity, b: ContainerlabExecutionIdentity): boolean {
  return stableJson(a) === stableJson(b);
}

function approvalError(): Error {
  return new Error("Containerlab discovery is not approved for this source. Run Test or Sync and choose Run to authorize it.");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createContainerlabActivationController(
  dependencies: ContainerlabActivationDependencies
): ContainerlabActivationController {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => globalThis.crypto.randomUUID());
  const sessionNonce = createId();
  const generations = new Map<string, string>();
  const approvals = new Map<string, ApprovalRecord>();
  const formSessions = new Map<string, FormSession>();
  const creationAssociations = new Map<string, FormSaveAssociation>();
  const pendingTransfers = new Map<string, PendingTransfer>();
  const pendingSourceMutations = new Map<string, string>();
  let disposed = false;
  let storeLoad: Promise<void> | undefined;
  let storeFailure: Error | undefined;
  let writeTail: Promise<void> = Promise.resolve();

  const loadedStore = async (): Promise<void> => {
    if (storeFailure) throw storeFailure;
    if (!storeLoad) {
      storeLoad = dependencies.store.load().then(
        () => undefined,
        (error: unknown) => {
          storeFailure = new Error(`Containerlab approval state could not be read: ${describeError(error)}`);
          throw storeFailure;
        }
      );
    }
    await storeLoad;
    if (storeFailure) throw storeFailure;
  };

  const currentRecords = (
    candidate?: ApprovalRecord,
    removedFormSessionId?: string
  ): ApprovalRecord[] => {
    const records = [...approvals.values()].filter((record) => !(record.scope === "form" && record.id === removedFormSessionId));
    for (const session of formSessions.values()) {
      if (session.id !== removedFormSessionId && session.approval) records.push(session.approval);
    }
    if (candidate) {
      const index = records.findIndex((record) => record.scope === candidate.scope && record.id === candidate.id);
      if (index < 0) records.push(candidate);
      else records[index] = candidate;
    }
    return records;
  };

  const persist = (
    candidate?: ApprovalRecord,
    removedFormSessionId?: string,
    stillCurrent?: () => boolean
  ): Promise<void> => {
    const operation = writeTail.then(async () => {
      await loadedStore();
      if (storeFailure) throw storeFailure;
      if (stillCurrent && !stillCurrent()) {
        throw new Error("Containerlab approval changed before its state could be saved.");
      }
      const document: StoredApprovalDocument = {
        schema: APPROVAL_SCHEMA,
        sessionNonce,
        records: currentRecords(candidate, removedFormSessionId).map((record) => ({
          ...record,
          executionIdentity: cloneExecutionIdentity(record.executionIdentity)
        }))
      };
      try {
        await dependencies.store.save(document);
      } catch (error) {
        storeFailure = new Error(`Containerlab approval state could not be saved: ${describeError(error)}`);
        throw storeFailure;
      }
    });
    writeTail = operation.catch(() => undefined);
    return operation;
  };

  const getSnapshot = () => dependencies.core.getSnapshot();

  const captureDependencies = (
    config: ContainerlabConfig,
    snapshot: ReturnType<typeof getSnapshot>
  ): { readonly dependencies?: InventorySourceDependencySnapshot; readonly identity: string | null; readonly labHost?: ServerConfig } => {
    if (config.location !== "ssh") return { identity: null };
    const hostId = config.labHostId;
    if (!hostId) throw new Error("Containerlab SSH discovery requires a configured lab host.");
    const labHost = snapshot.servers.find((server) => server.id === hostId);
    if (!labHost) throw new Error("Containerlab SSH discovery requires the configured lab host to exist.");
    const route = snapshotInventorySourceDependencies(hostId, snapshot.servers, snapshot.authProfiles);
    return {
      dependencies: route,
      identity: route.identity,
      labHost: cloneServerConfig(labHost)
    };
  };

  const isTrusted = (): boolean => {
    try {
      return dependencies.isWorkspaceTrusted();
    } catch {
      return false;
    }
  };

  const checkDependencyCurrent = (
    capture: Pick<OperationCapture, "config" | "dependencies" | "dependencyIdentity">
  ): boolean => {
    try {
      const snapshot = getSnapshot();
      if (capture.config.location === "local") return capture.dependencyIdentity === null;
      if (!capture.dependencies) return false;
      assertInventorySourceDependenciesCurrent(capture.dependencies, snapshot.servers, snapshot.authProfiles);
      return capture.dependencies.identity === capture.dependencyIdentity;
    } catch {
      return false;
    }
  };

  const captureOperation = (
    config: ContainerlabConfig,
    operationContext: InventoryOperationContext | undefined,
    deadline: number,
    signal: AbortSignal
  ): OperationCapture => {
    if (disposed) throw new Error("Containerlab activation controller is disposed.");
    if (!operationContext || !operationContext.subject) throw new Error("Containerlab inspection requires a valid operation context.");
    if (!isTrusted()) throw new Error("Containerlab inspection requires a trusted workspace.");
    const snapshot = getSnapshot();
    const subject = operationContext.subject;
    let source: InventorySourceConfig | undefined;
    let form: FormSession | undefined;
    let generation: string | undefined;
    let formGeneration: string | undefined;
    let values: InventorySourceValues;
    if (subject.kind === "source") {
      source = snapshot.inventorySources.find((item) => item.id === subject.sourceId);
      if (!source || typeof source.revision !== "string" || source.revision !== subject.revision) {
        throw new Error("Containerlab operation context no longer matches the saved source revision.");
      }
      if (pendingSourceMutations.has(source.id)) throw new Error("Containerlab source is being replaced or removed.");
      if (source.providerId !== "containerlab") throw new Error("Containerlab operation context names a different inventory provider.");
      if (operationContext.intent === "background-status" && !generations.has(source.id)) throw approvalError();
      if (operationContext.intent === "manual-status" && !generations.has(source.id)) throw approvalError();
      if (!generations.has(source.id)) generations.set(source.id, createId());
      generation = generations.get(source.id);
      values = source.config;
    } else {
      if (operationContext.intent !== "test") throw new Error("Only Test can inspect an unsaved Containerlab form.");
      form = formSessions.get(subject.sessionId);
      if (!form || !form.values) throw new Error("Containerlab form session is missing, closed, or has no tested values.");
      if (form.editOrigin) {
        if (pendingSourceMutations.has(form.editOrigin.sourceId)) throw new Error("The edited Containerlab source is being replaced or removed.");
        const origin = snapshot.inventorySources.find((item) => item.id === form!.editOrigin!.sourceId);
        if (!origin || origin.revision !== form.editOrigin.revision) {
          throw new Error("The Containerlab source changed since this Edit form was opened.");
        }
      }
      formGeneration = form.generation;
      values = form.values;
    }
    const parsed = parseContainerlabConfig(values);
    if (stableJson(parsed) !== stableJson(config)) {
      throw new Error("Containerlab operation config does not match the captured source or form intent.");
    }
    const fullIntentKey = intentKey("containerlab", values);
    const capturedDependencies = captureDependencies(parsed, snapshot);
    const capture: OperationCapture = {
      intent: operationContext.intent,
      ...(source ? { source } : {}),
      ...(form ? { form } : {}),
      ...(generation ? { sourceGeneration: generation } : {}),
      ...(formGeneration ? { formGeneration } : {}),
      config: parsed,
      intentKey: fullIntentKey,
      ...(capturedDependencies.dependencies ? { dependencies: capturedDependencies.dependencies } : {}),
      dependencyIdentity: capturedDependencies.identity,
      ...(capturedDependencies.labHost ? { labHost: capturedDependencies.labHost } : {}),
      deadline,
      signal,
      isCurrent: () => false
    };
    (capture as { isCurrent: () => boolean }).isCurrent = () => {
      if (disposed || signal.aborted || now() >= deadline || !isTrusted()) return false;
      if (!checkDependencyCurrent(capture)) return false;
      if (capture.source) {
        if (pendingSourceMutations.has(capture.source.id)) return false;
        if (generations.get(capture.source.id) !== capture.sourceGeneration) return false;
        const current = getSnapshot().inventorySources.find((item) => item.id === capture.source!.id);
        return Boolean(current && current.revision === capture.source!.revision && intentKey(current.providerId, current.config) === capture.intentKey);
      }
      const currentForm = formSessions.get(capture.form!.id);
      if (!currentForm || currentForm.generation !== capture.formGeneration || !currentForm.values) return false;
      if (intentKey("containerlab", currentForm.values) !== capture.intentKey) return false;
      if (currentForm.editOrigin) {
        const currentOrigin = getSnapshot().inventorySources.find((item) => item.id === currentForm.editOrigin!.sourceId);
        if (!currentOrigin || currentOrigin.revision !== currentForm.editOrigin.revision) return false;
      }
      return true;
    };
    return capture;
  };

  const ensureCurrent = (capture: OperationCapture): void => {
    if (capture.signal.aborted) {
      const reason = capture.signal.reason;
      throw reason instanceof Error ? reason : new Error("Containerlab inspection was canceled.");
    }
    if (now() >= capture.deadline) throw new Error("Containerlab inspection exceeded its 30-second deadline.");
    if (!capture.isCurrent()) throw new Error("Containerlab source, form, workspace trust, or SSH route changed during inspection.");
  };

  const runDescription = (config: ContainerlabConfig, host?: ServerConfig): string => {
    const location = config.location === "ssh" ? `SSH host ${host?.name ?? config.labHostId}` : "this extension host";
    const runner = config.runner === "host"
      ? `host binary ${config.containerlabExecutable}`
      : config.runner === "disposable"
        ? `disposable Docker image ${config.runnerImage}`
        : `existing Docker container ${config.runnerContainer}`;
    const sudo = config.sudo ? " using noninteractive sudo" : " without sudo";
    return `Run Containerlab discovery on ${location} with ${runner}${sudo}. Docker daemon: ${config.dockerSocket}. It will check Docker info and the selected runner, run Containerlab version, then inspect all labs with details.`;
  };

  const newGeneration = (): string => createId();

  const revokeSourceMemory = (sourceId: string, removeGeneration: boolean): void => {
    approvals.delete(sourceId);
    pendingTransfers.delete(sourceId);
    creationAssociations.delete(sourceId);
    if (removeGeneration) generations.delete(sourceId);
    else generations.set(sourceId, newGeneration());
  };

  const revokeFormMemory = (session: FormSession): void => {
    session.approval = undefined;
    session.generation = newGeneration();
    for (const [sourceId, association] of creationAssociations) {
      if (association.sessionId === session.id) creationAssociations.delete(sourceId);
    }
    for (const [sourceId, transfer] of pendingTransfers) {
      if (transfer.sessionId === session.id) pendingTransfers.delete(sourceId);
    }
  };

  const mutationDependenciesMatch = (source: InventorySourceConfig, identity: string | null): boolean => {
    try {
      const parsed = parseContainerlabConfig(source.config);
      return captureDependencies(parsed, getSnapshot()).identity === identity;
    } catch {
      return false;
    }
  };

  const associationForMutation = (mutation: InventorySourceMutation): FormSaveAssociation | undefined => {
    const association = creationAssociations.get(mutation.sourceId);
    if (!association) return undefined;
    creationAssociations.delete(mutation.sourceId);
    if (mutation.forceNewActivationGeneration === true) return undefined;
    const form = formSessions.get(association.sessionId);
    const next = mutation.next;
    if (!form || !form.approval || !next || form.generation !== association.formGeneration) return undefined;
    if (form.approval.intentKey !== association.intentKey || intentKey(next.providerId, next.config) !== association.intentKey) return undefined;
    if (form.approval.dependencyIdentity !== association.dependencyIdentity || !mutationDependenciesMatch(next, association.dependencyIdentity)) return undefined;
    if (!executionIdentityEqual(form.approval.executionIdentity, association.executionIdentity)) return undefined;
    if (association.expectedPreviousRevision === undefined) {
      if (mutation.kind !== "create" || mutation.previous !== undefined) return undefined;
    } else if (
      mutation.kind === "replace" ||
      mutation.previous?.revision !== association.expectedPreviousRevision
    ) {
      return undefined;
    }
    return association;
  };

  const prepareCoreMutation = async (
    mutation: InventorySourceMutation
  ): Promise<InventorySourceMutationPreparation> => {
    const token = createId();
    pendingSourceMutations.set(mutation.sourceId, token);
    const transferAssociation = mutation.kind === "replace" || mutation.kind === "delete"
      ? (creationAssociations.delete(mutation.sourceId), undefined)
      : associationForMutation(mutation);

    if (mutation.kind === "metadata" && !transferAssociation && mutation.previous && mutation.next) {
      const approval = approvals.get(mutation.sourceId);
      const generation = generations.get(mutation.sourceId);
      const canCarry = Boolean(
        approval &&
        generation &&
        approval.generation === generation &&
        approval.acceptedRevision === mutation.previous.revision &&
        approval.intentKey === intentKey(mutation.previous.providerId, mutation.previous.config) &&
        approval.intentKey === intentKey(mutation.next.providerId, mutation.next.config) &&
        mutationDependenciesMatch(mutation.next, approval.dependencyIdentity)
      );
      if (canCarry && approval) {
        const nextApproval: ApprovalRecord = { ...approval, acceptedRevision: mutation.next.revision };
        try {
          await persist(nextApproval, undefined, () =>
            pendingSourceMutations.get(mutation.sourceId) === token &&
            generations.get(mutation.sourceId) === approval.generation &&
            dependencies.core.getInventorySource(mutation.sourceId) === mutation.previous &&
            isTrusted() &&
            mutationDependenciesMatch(mutation.previous!, approval.dependencyIdentity)
          );
          approvals.set(mutation.sourceId, nextApproval);
        } catch (error) {
          revokeSourceMemory(mutation.sourceId, false);
          pendingSourceMutations.delete(mutation.sourceId);
          throw error;
        }
        return {
          commit: () => {
            if (pendingSourceMutations.get(mutation.sourceId) === token) pendingSourceMutations.delete(mutation.sourceId);
          },
          abort: () => {
            if (pendingSourceMutations.get(mutation.sourceId) === token) {
              revokeSourceMemory(mutation.sourceId, false);
              pendingSourceMutations.delete(mutation.sourceId);
              void persist().catch(() => undefined);
            }
          }
        };
      }
    }

    revokeSourceMemory(mutation.sourceId, mutation.kind === "delete");
    if (mutation.kind !== "delete" && transferAssociation && mutation.next) {
      const nextGeneration = generations.get(mutation.sourceId)!;
      pendingTransfers.set(mutation.sourceId, {
        ...transferAssociation,
        sourceGeneration: nextGeneration,
        acceptedRevision: mutation.next.revision!
      });
    }
    try {
      await persist(undefined, undefined, () => pendingSourceMutations.get(mutation.sourceId) === token);
    } catch (error) {
      pendingSourceMutations.delete(mutation.sourceId);
      pendingTransfers.delete(mutation.sourceId);
      throw error;
    }
    return {
      commit: () => {
        if (pendingSourceMutations.get(mutation.sourceId) === token) pendingSourceMutations.delete(mutation.sourceId);
      },
      abort: () => {
        if (pendingSourceMutations.get(mutation.sourceId) === token) {
          pendingTransfers.delete(mutation.sourceId);
          pendingSourceMutations.delete(mutation.sourceId);
          void persist().catch(() => undefined);
        }
      }
    };
  };

  const unregisterMutation = dependencies.core.onPrepareInventorySourceMutation(prepareCoreMutation);

  const controller: ContainerlabActivationController = {
    async inspect(config, operationContext) {
      const deadline = now() + RUN_DEADLINE_MS;
      const abortController = new AbortController();
      const externalSignal = operationContext?.signal;
      const abortFromCaller = () => abortController.abort(externalSignal?.reason ?? new Error("Containerlab inspection was canceled."));
      if (externalSignal?.aborted) abortFromCaller();
      else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimeout(() => abortController.abort(new Error("Containerlab inspection exceeded its 30-second deadline.")), Math.max(0, deadline - now()));
      let capture: OperationCapture;
      try {
        capture = captureOperation(config, operationContext, deadline, abortController.signal);
        await loadedStore();
        ensureCurrent(capture);

        const isBackground = capture.intent === "background-status" || capture.intent === "manual-status";
        let approved: ApprovalRecord | undefined;
        if (isBackground) {
          if (!capture.source) throw approvalError();
          approved = approvals.get(capture.source.id);
          if (
            !approved ||
            approved.scope !== "source" ||
            approved.generation !== capture.sourceGeneration ||
            approved.acceptedRevision !== capture.source.revision ||
            approved.intentKey !== capture.intentKey ||
            approved.dependencyIdentity !== capture.dependencyIdentity
          ) {
            throw approvalError();
          }
        } else {
          if (capture.intent !== "test" && capture.intent !== "sync") {
            throw new Error("Containerlab inspection requires a Test, Sync, or approved status operation.");
          }
          const allowed = await dependencies.confirmRun(runDescription(capture.config, capture.labHost));
          if (!allowed) throw new Error("Containerlab Run was canceled.");
          ensureCurrent(capture);
        }

        const runContext: ContainerlabRunContext = {
          interaction: isBackground ? "noninteractive" : "interactive",
          signal: abortController.signal,
          deadline,
          ...(capture.labHost ? { labHost: cloneServerConfig(capture.labHost) } : {}),
          ...(capture.dependencyIdentity ? { labHostRouteIdentity: capture.dependencyIdentity } : {}),
          isCurrent: () => capture.isCurrent()
        };
        ensureCurrent(capture);
        const resolved = await dependencies.executor.resolveDependencies(
          capture.config,
          runContext,
          approved ? cloneExecutionIdentity(approved.executionIdentity) : undefined
        );
        ensureCurrent(capture);
        if (approved && !executionIdentityEqual(resolved.identity, approved.executionIdentity)) {
          throw new Error("The resolved Containerlab execution identity changed since approval.");
        }
        const prepared = await dependencies.executor.preflight(capture.config, resolved, runContext);
        ensureCurrent(capture);
        if (!executionIdentityEqual(prepared.identity, resolved.identity)) {
          throw new Error("Containerlab version preflight returned a different execution identity.");
        }
        if (approved && !executionIdentityEqual(prepared.identity, approved.executionIdentity)) {
          throw new Error("The approved Containerlab execution identity changed during version preflight.");
        }

        if (!isBackground) {
          if (capture.source) {
            const nextApproval: ApprovalRecord = {
              scope: "source",
              id: capture.source.id,
              generation: capture.sourceGeneration!,
              acceptedRevision: capture.source.revision,
              intentKey: capture.intentKey,
              dependencyIdentity: capture.dependencyIdentity,
              executionIdentity: cloneExecutionIdentity(prepared.identity)
            };
            await persist(nextApproval, undefined, capture.isCurrent);
            ensureCurrent(capture);
            approvals.set(capture.source.id, nextApproval);
          } else {
            const form = capture.form!;
            const nextApproval: ApprovalRecord = {
              scope: "form",
              id: form.id,
              generation: capture.formGeneration!,
              intentKey: capture.intentKey,
              dependencyIdentity: capture.dependencyIdentity,
              executionIdentity: cloneExecutionIdentity(prepared.identity)
            };
            await persist(nextApproval, undefined, capture.isCurrent);
            ensureCurrent(capture);
            form.approval = nextApproval;
          }
        }
        const result = await dependencies.executor.inspect(capture.config, prepared, runContext);
        ensureCurrent(capture);
        return result;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abortFromCaller);
      }
    },

    beginFormSession(editOrigin) {
      if (disposed) throw new Error("Containerlab activation controller is disposed.");
      let boundOrigin: FormSession["editOrigin"];
      if (editOrigin) {
        const source = getSnapshot().inventorySources.find((item) => item.id === editOrigin.sourceId);
        if (!source || source.providerId !== "containerlab" || source.revision !== editOrigin.revision) {
          throw new Error("The Containerlab source changed before its Edit form opened.");
        }
        boundOrigin = Object.freeze({ sourceId: editOrigin.sourceId, revision: editOrigin.revision });
      }
      const id = createId();
      formSessions.set(id, { id, generation: createId(), ...(boundOrigin ? { editOrigin: boundOrigin } : {}) });
      return id;
    },

    updateFormSession(sessionId, values) {
      const session = formSessions.get(sessionId);
      if (!session) throw new Error("Containerlab form session is missing or closed.");
      const nextValues = cloneValues(values);
      const changed = session.values !== undefined && stableJson(session.values) !== stableJson(nextValues);
      if (changed) revokeFormMemory(session);
      session.values = nextValues;
      if (changed) void persist().catch(() => undefined);
    },

    endFormSession(sessionId) {
      const session = formSessions.get(sessionId);
      if (!session) return;
      const hadApproval = session.approval !== undefined;
      formSessions.delete(sessionId);
      revokeFormMemory(session);
      if (hadApproval) void persist(undefined, sessionId).catch(() => undefined);
    },

    prepareFormSourceSave(sessionId, sourceId) {
      if (disposed) throw new Error("Containerlab activation controller is disposed.");
      const session = formSessions.get(sessionId);
      if (!session || !session.values || !session.approval || !isTrusted()) {
        throw new Error("Containerlab form must have an active, tested approval before saving.");
      }
      const snapshot = getSnapshot();
      const source = snapshot.inventorySources.find((item) => item.id === sourceId);
      if (session.editOrigin) {
        if (session.editOrigin.sourceId !== sourceId) throw new Error("Edit approval cannot be transferred to a different source ID.");
        if (!source || source.revision !== session.editOrigin.revision) {
          throw new Error("The edited Containerlab source changed since this form was opened.");
        }
      } else if (source) {
        throw new Error("Add approval can only be prepared for a source ID that does not already exist.");
      }
      if (session.approval.intentKey !== intentKey("containerlab", session.values)) {
        throw new Error("Containerlab form values changed after their successful Test.");
      }
      const currentRoute = captureDependencies(parseContainerlabConfig(session.values), snapshot);
      if (currentRoute.identity !== session.approval.dependencyIdentity) {
        throw new Error("Containerlab SSH dependencies changed after the successful Test.");
      }
      const association: FormSaveAssociation = {
        token: createId(),
        sessionId,
        formGeneration: session.generation,
        sourceId,
        ...(session.editOrigin ? { expectedPreviousRevision: session.editOrigin.revision } : {}),
        intentKey: session.approval.intentKey,
        dependencyIdentity: session.approval.dependencyIdentity,
        executionIdentity: cloneExecutionIdentity(session.approval.executionIdentity)
      };
      creationAssociations.set(sourceId, association);
      return () => {
        if (creationAssociations.get(sourceId)?.token === association.token) creationAssociations.delete(sourceId);
      };
    },

    async invalidateSource(sourceId) {
      pendingSourceMutations.set(sourceId, createId());
      revokeSourceMemory(sourceId, false);
      await persist();
      pendingSourceMutations.delete(sourceId);
    },

    async invalidateAllSources() {
      const ids = new Set([...generations.keys(), ...approvals.keys()]);
      for (const id of ids) {
        pendingSourceMutations.set(id, createId());
        revokeSourceMemory(id, false);
      }
      await persist();
      pendingSourceMutations.clear();
    },

    async transferFormApproval(sessionId, source) {
      const transfer = [...pendingTransfers.values()].find((item) => item.sessionId === sessionId);
      if (transfer) pendingTransfers.delete(transfer.sourceId);
      const session = formSessions.get(sessionId);
      if (!transfer || !session || !session.values || !session.approval || transfer.sourceId !== source.id) {
        throw new Error("Containerlab form has no matching one-shot source save or its tested approval changed.");
      }
      if (session.generation !== transfer.formGeneration || session.approval.generation !== transfer.formGeneration) {
        throw new Error("Containerlab form changed or closed before approval transfer.");
      }
      if (
        intentKey("containerlab", session.values) !== transfer.intentKey ||
        intentKey(source.providerId, source.config) !== transfer.intentKey
      ) {
        throw new Error("Saved Containerlab source does not match the exact tested form intent.");
      }
      const snapshot = getSnapshot();
      const live = snapshot.inventorySources.find((item) => item.id === source.id);
      if (!live || live.revision !== transfer.acceptedRevision || source.revision !== transfer.acceptedRevision) {
        throw new Error("Saved Containerlab source generation changed before approval transfer.");
      }
      if (
        generations.get(source.id) !== transfer.sourceGeneration ||
        pendingSourceMutations.has(source.id) ||
        !mutationDependenciesMatch(live, transfer.dependencyIdentity)
      ) {
        throw new Error("Saved Containerlab source or SSH dependencies changed before approval transfer.");
      }
      if (session.editOrigin && session.editOrigin.revision !== transfer.expectedPreviousRevision) {
        throw new Error("Containerlab Edit approval does not match the source revision opened by this form.");
      }
      const approval: ApprovalRecord = {
        scope: "source",
        id: source.id,
        generation: transfer.sourceGeneration,
        acceptedRevision: transfer.acceptedRevision,
        intentKey: transfer.intentKey,
        dependencyIdentity: transfer.dependencyIdentity,
        executionIdentity: cloneExecutionIdentity(transfer.executionIdentity)
      };
      const stillCurrent = () => {
        const currentSession = formSessions.get(sessionId);
        const currentSource = getSnapshot().inventorySources.find((item) => item.id === source.id);
        return Boolean(
          !disposed &&
          isTrusted() &&
          currentSession === session &&
          currentSession.generation === transfer.formGeneration &&
          currentSession.approval === session.approval &&
          currentSource?.revision === transfer.acceptedRevision &&
          generations.get(source.id) === transfer.sourceGeneration &&
          !pendingSourceMutations.has(source.id) &&
          intentKey("containerlab", currentSession.values!) === transfer.intentKey &&
          mutationDependenciesMatch(currentSource!, transfer.dependencyIdentity)
        );
      };
      await persist(approval, sessionId, stillCurrent);
      if (!stillCurrent()) {
        void persist().catch(() => undefined);
        throw new Error("Containerlab form or source changed while approval was being transferred.");
      }
      approvals.set(source.id, approval);
      session.approval = undefined;
    },

    dispose() {
      disposed = true;
      unregisterMutation();
      formSessions.clear();
      creationAssociations.clear();
      pendingTransfers.clear();
      pendingSourceMutations.clear();
    }
  };

  return controller;
}
