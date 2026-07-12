export class ObjectUrlPool {
  private readonly entries = new Map<string, { blob: Blob; url: string; usedAt: number }>();

  constructor(private readonly limit = 24) {}

  acquire(key: string, blob: Blob): string {
    const existing = this.entries.get(key);
    if (existing?.blob === blob) {
      existing.usedAt = Date.now();
      return existing.url;
    }
    if (existing) this.release(key);
    const url = URL.createObjectURL(blob);
    this.entries.set(key, { blob, url, usedAt: Date.now() });
    this.trim();
    return url;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    this.entries.delete(key);
  }

  clear(): void {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.limit) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (!oldest) return;
      this.release(oldest[0]);
    }
  }
}
