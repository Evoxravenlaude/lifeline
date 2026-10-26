import type { Action } from "./types.js";

const actions = new Map<string, Action>();

export function register(...list: Action<any>[]) {
  for (const a of list) {
    if (actions.has(a.name)) throw new Error(`duplicate action ${a.name}`);
    actions.set(a.name, a);
  }
}

export function getAction(name: string): Action | undefined {
  return actions.get(name);
}

export function allActions(): Action[] {
  return [...actions.values()];
}
