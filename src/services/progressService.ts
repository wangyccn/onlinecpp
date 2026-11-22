/**
 * IDEA-style progress bar service.
 * Shows a thin progress bar at the top of the editor area during long-running tasks:
 * compilation, file write queue, network requests, WASM toolchain download.
 */
export type ProgressTaskId = string;

export interface ProgressTask {
  id: ProgressTaskId;
  label: string;
  percentage: number; // 0-100, or -1 for indeterminate
  startedAt: number;
}

class ProgressService {
  private tasks = new Map<ProgressTaskId, ProgressTask>();
  private container: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  /** Attach the progress bar DOM to the page. Called once on init. */
  public mount(): void {
    if (this.container) return;
    const host = (document.querySelector('.editor-panel-area') || document.body) as HTMLElement;
    this.container = document.createElement('div');
    this.container.className = 'progress-bar-container';
    this.container.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; height: 3px;
      z-index: 1000; pointer-events: none; display: none;
      background: rgba(0,0,0,0.1);
    `;
    this.bar = document.createElement('div');
    this.bar.className = 'progress-bar-fill';
    this.bar.style.cssText = `
      height: 100%; width: 0%; transition: width 0.2s ease, opacity 0.3s ease;
      background: linear-gradient(90deg, #007acc, #4fc1ff);
      border-radius: 0 2px 2px 0;
      box-shadow: 0 0 4px rgba(0,122,204,0.5);
    `;
    this.label = document.createElement('div');
    this.label.className = 'progress-bar-label';
    this.label.style.cssText = `
      position: absolute; top: 5px; right: 8px; font-size: 11px;
      color: #858585; white-space: nowrap; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;
    this.container.appendChild(this.bar);
    this.container.appendChild(this.label);
    host.style.position = host.style.position || 'relative';
    host.appendChild(this.container);
  }

  /** Start a tracked task. Returns an object to update or complete it. */
  public start(id: ProgressTaskId, label: string, percentage = -1): { update: (pct: number, label?: string) => void; done: () => void } {
    const task: ProgressTask = { id, label, percentage, startedAt: Date.now() };
    this.tasks.set(id, task);
    this.render();
    return {
      update: (pct: number, newLabel?: string) => {
        const t = this.tasks.get(id);
        if (t) { t.percentage = pct; if (newLabel) t.label = newLabel; this.render(); }
      },
      done: () => {
        this.tasks.delete(id);
        this.render();
      },
    };
  }

  /** Whether any task is currently active. */
  public get busy(): boolean { return this.tasks.size > 0; }

  private render(): void {
    if (!this.container || !this.bar || !this.label) return;
    if (this.tasks.size === 0) {
      // Delay hide to avoid flicker on rapid task transitions
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (this.container) this.container.style.display = 'none';
      }, 200);
      this.bar.style.width = '100%';
      this.bar.style.opacity = '0';
      return;
    }
    clearTimeout(this.hideTimer);
    this.container.style.display = 'block';
    this.bar.style.opacity = '1';

    const tasks = [...this.tasks.values()];
    // Show the most recently started task's label
    const primary = tasks[tasks.length - 1];
    const determinate = tasks.filter((t) => t.percentage >= 0);
    if (determinate.length > 0) {
      const avg = determinate.reduce((sum, t) => sum + t.percentage, 0) / determinate.length;
      this.bar.style.width = `${Math.min(100, avg)}%`;
    } else {
      // Indeterminate: animated bar
      this.bar.style.width = '30%';
      this.bar.style.animation = 'progress-indeterminate 1.5s ease-in-out infinite';
    }

    const labels = tasks.map((t) => t.label).join(' | ');
    this.label.textContent = labels;
    this.label.style.opacity = '1';
  }
}

export const progressService = new ProgressService();
