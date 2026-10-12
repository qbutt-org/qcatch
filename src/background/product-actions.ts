import type {
  ProductAction,
  ProductActionKind,
  ProductSelection,
} from "../shared/integration.ts";
import { productActionKey } from "../shared/integration.ts";
import { NativeBridgeError } from "./native.ts";

interface ActiveAction {
  id: string;
  key: string;
  previousId?: string;
  task: Promise<ProductAction>;
}

const active = new Map<number, ActiveAction>();
const mutations = new Map<number, Promise<unknown>>();

async function mutateActions<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutations.set(tabId, current);
  try {
    return await current;
  } finally {
    if (mutations.get(tabId) === current) mutations.delete(tabId);
  }
}

async function storedActions(tabId: number): Promise<ProductAction[]> {
  const key = `product-actions:${tabId}`;
  const saved = await chrome.storage.session.get(key);
  return (saved[key] as ProductAction[] | undefined) ?? [];
}

export async function readProductActions(tabId: number): Promise<ProductAction[]> {
  return mutateActions(tabId, async () => {
    const actions = await storedActions(tabId);
    let changed = false;
    for (const action of actions) {
      if (active.get(tabId)?.id === action.id) continue;
      if (action.status === "preparing") {
        action.status = "failed";
        action.error = "Передача прервана. Повторите попытку.";
        changed = true;
      } else if (action.status === "sending") {
        action.status = "uncertain";
        action.error = "Ответ потерян. Проверьте окно приложения.";
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.session.set({ [`product-actions:${tabId}`]: actions });
    }
    return actions;
  });
}

export async function removeProductActions(tabId: number): Promise<void> {
  active.delete(tabId);
  await mutateActions(tabId, () => chrome.storage.session.remove(`product-actions:${tabId}`));
}

export function performProductAction(
  selection: ProductSelection,
  action: ProductActionKind,
  previousId: string | undefined,
  prepare: () => Promise<() => Promise<void>>,
): Promise<ProductAction> {
  const key = productActionKey(action, selection);
  const current = active.get(selection.tabId);
  if (current) {
    if (current.key === key && current.previousId === previousId) return current.task;
    return readProductActions(selection.tabId).then((actions) => {
      const previous = actions.find((item) => item.key === key && item.previousId === previousId);
      if (previous) return previous;
      throw new Error("Дождитесь текущей передачи.");
    });
  }

  const id = crypto.randomUUID();
  const intent: ProductAction = {
    id,
    key,
    action,
    status: "preparing",
    ...(previousId !== undefined ? { previousId } : {}),
  };
  const task = (async () => {
    const actions = await readProductActions(selection.tabId);
    const previous = actions.find((item) => item.key === key && item.previousId === previousId);
    if (previous) return previous;
    if (previousId !== undefined) {
      const parent = actions.find((item) => item.id === previousId && item.key === key);
      if (!parent || parent.status !== "sent" && parent.status !== "failed") {
        throw new Error("Выбор передачи устарел. Откройте qcatch заново.");
      }
    }

    const save = (next: ProductAction): Promise<void> => mutateActions(selection.tabId, async () => {
      const latest = await storedActions(selection.tabId);
      if (active.get(selection.tabId)?.id !== id) {
        throw new Error("Страница изменилась. Откройте qcatch заново.");
      }
      const remaining = latest.filter((item) => item.id !== id);
      await chrome.storage.session.set({
        [`product-actions:${selection.tabId}`]: [...remaining, next],
      });
    });

    try {
      await save(intent);
      const send = await prepare();
      intent.status = "sending";
      await save(intent);
      await send();
      intent.status = "sent";
    } catch (error) {
      intent.status = error instanceof NativeBridgeError && error.deliveryUncertain
        ? "uncertain" : "failed";
      intent.error = intent.status === "uncertain"
        ? "Ответ потерян. Проверьте окно приложения."
        : error instanceof Error ? error.message : String(error);
    }
    await save(intent);
    return intent;
  })().finally(() => {
    if (active.get(selection.tabId)?.id === id) active.delete(selection.tabId);
  });
  active.set(selection.tabId, { id, key, task, ...(previousId !== undefined ? { previousId } : {}) });
  return task;
}
