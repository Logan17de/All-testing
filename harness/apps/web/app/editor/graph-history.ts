import { useCallback, useReducer, type SetStateAction } from "react";

import type { GraphDocument } from "../../lib/graph-document";

export interface GraphHistory {
  readonly past: readonly GraphDocument[];
  readonly present: GraphDocument;
  readonly future: readonly GraphDocument[];
}

type HistoryAction =
  | { readonly type: "edit"; readonly update: SetStateAction<GraphDocument> }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

const HISTORY_LIMIT = 80;

/** Whole documents preserve bindings, connections and layout across destructive edits. */
export function graphHistoryReducer(state: GraphHistory, action: HistoryAction): GraphHistory {
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous === undefined
      ? state
      : {
          past: state.past.slice(0, -1),
          present: previous,
          future: [state.present, ...state.future],
        };
  }
  if (action.type === "redo") {
    const next = state.future[0];
    return next === undefined
      ? state
      : { past: [...state.past, state.present], present: next, future: state.future.slice(1) };
  }
  const next = typeof action.update === "function" ? action.update(state.present) : action.update;
  if (next === state.present) return state;
  return {
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present],
    present: next,
    future: [],
  };
}

export function useGraphHistory(load: () => GraphDocument) {
  const [history, dispatch] = useReducer(graphHistoryReducer, undefined, () => ({
    past: [],
    present: load(),
    future: [],
  }));
  const setGraph = useCallback((update: SetStateAction<GraphDocument>) => {
    dispatch({ type: "edit", update });
  }, []);
  const undo = useCallback(() => {
    dispatch({ type: "undo" });
  }, []);
  const redo = useCallback(() => {
    dispatch({ type: "redo" });
  }, []);
  return {
    graph: history.present,
    setGraph,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
