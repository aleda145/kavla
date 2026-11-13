// Optional layout refinements must yield to responsiveness. Check before work
// and finish/restore the current probe before returning when the budget expires.
export function createLayoutBudget(milliseconds: number, operations: number): () => boolean {
  const deadline = performance.now() + milliseconds;
  return () => --operations >= 0 && performance.now() < deadline;
}
