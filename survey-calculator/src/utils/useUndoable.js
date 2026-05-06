/**
 * useUndoable
 *
 * Returns [present, set, undo, redo, canUndo, canRedo].
 * Maintains a bounded history stack so surveying field operators can easily
 * recover from mis-clicks during point collection workflows.
 *
 * @param {*} initialValue - Initial state value.
 * @param {number} [maxHistory=50] - Maximum number of undo steps.
 */
import { useState, useCallback } from 'react';

export default function useUndoable(initialValue, maxHistory = 50) {
  const [history, setHistory] = useState({
    past: [],
    present: initialValue,
    future: [],
  });

  /** Replace the present value and push the old value onto the undo stack. */
  const set = useCallback(
    (newValueOrUpdater) => {
      setHistory((prev) => {
        const next =
          typeof newValueOrUpdater === 'function'
            ? newValueOrUpdater(prev.present)
            : newValueOrUpdater;
        // Skip if nothing changed (avoids polluting the history stack)
        if (next === prev.present) return prev;
        return {
          past: [...prev.past.slice(-(maxHistory - 1)), prev.present],
          present: next,
          future: [],
        };
      });
    },
    [maxHistory],
  );

  /** Revert to the previous state. */
  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const newPast = prev.past.slice(0, -1);
      const newPresent = prev.past[prev.past.length - 1];
      return {
        past: newPast,
        present: newPresent,
        future: [prev.present, ...prev.future],
      };
    });
  }, []);

  /** Re-apply a previously undone state. */
  const redo = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const [newPresent, ...newFuture] = prev.future;
      return {
        past: [...prev.past, prev.present],
        present: newPresent,
        future: newFuture,
      };
    });
  }, []);

  /** Wipe the full history and reset to a new value (e.g. workspace reset). */
  const reset = useCallback((newValue) => {
    setHistory({
      past: [],
      present: newValue !== undefined ? newValue : initialValue,
      future: [],
    });
  // initialValue is only used as a default; it should be stable (primitive / ref).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [
    history.present,
    set,
    undo,
    redo,
    history.past.length > 0,   // canUndo
    history.future.length > 0,  // canRedo
    reset,
  ];
}
