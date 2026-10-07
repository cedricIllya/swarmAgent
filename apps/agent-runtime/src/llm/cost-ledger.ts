/**
 * Сумма `usage.cost` от OpenRouter за время одного хода Hermes.
 * Параллельные ходы не делят одно списание дважды: пересечение копится
 * отдельно и достаётся ходу, который закрылся последним.
 */
export class LlmCostLedger {
  private readonly turns = new Set<string>();
  private readonly assigned = new Map<string, number>();
  private unassigned = 0;

  begin(id: string): void {
    this.turns.add(id);
  }

  note(costUsd: number): void {
    if (!(costUsd > 0)) return;
    if (this.turns.size === 1) {
      const id = [...this.turns][0]!;
      this.assigned.set(id, (this.assigned.get(id) ?? 0) + costUsd);
      return;
    }
    this.unassigned += costUsd;
  }

  end(id: string): number {
    this.turns.delete(id);
    const own = this.assigned.get(id) ?? 0;
    this.assigned.delete(id);
    if (this.turns.size > 0) return own;
    const total = own + this.unassigned;
    this.unassigned = 0;
    return total;
  }
}
