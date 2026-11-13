/**
 * Live view of a pipeline run: elapsed time, the current step and the latest
 * activity of each agent. Rendering is throttled so a chatty agent cannot
 * flood the terminal.
 */

import { formatDuration } from "../core/summary.ts";
import type { PipelineObserver } from "../engine/pipeline.ts";

const MIN_INTERVAL_MS = 150;
const NOTICE_LIMIT = 4;

export class ProgressView implements PipelineObserver {
	private readonly started = performance.now();
	private readonly emit: (text: string) => void;
	private readonly onStatus?: (step: string) => void;
	private step = "starting";
	private readonly activity = new Map<string, string>();
	private readonly notices: string[] = [];
	private ticker: NodeJS.Timeout | undefined;
	private pending: NodeJS.Timeout | undefined;
	private lastRender = 0;
	private stopped = false;

	constructor(emit: (text: string) => void, onStatus?: (step: string) => void) {
		this.emit = emit;
		this.onStatus = onStatus;
	}

	start(): void {
		this.ticker = setInterval(() => this.render(), 1000);
		this.ticker.unref();
		this.render();
	}

	stop(): void {
		this.stopped = true;
		clearInterval(this.ticker);
		clearTimeout(this.pending);
	}

	onStep = (step: string): void => {
		this.step = step;
		this.activity.clear();
		this.onStatus?.(step);
		this.schedule();
	};

	onActivity = (label: string, text: string): void => {
		this.activity.set(label, text);
		this.schedule();
	};

	onNotice = (text: string): void => {
		this.notices.push(text);
		if (this.notices.length > NOTICE_LIMIT) this.notices.shift();
		this.schedule();
	};

	/** Notices collected so far, for inclusion in the final tool result. */
	get collectedNotices(): readonly string[] {
		return this.notices;
	}

	private schedule(): void {
		if (this.stopped || this.pending) return;
		const wait = Math.max(0, MIN_INTERVAL_MS - (performance.now() - this.lastRender));
		this.pending = setTimeout(() => {
			this.pending = undefined;
			this.render();
		}, wait);
		this.pending.unref();
	}

	private render(): void {
		if (this.stopped) return;
		this.lastRender = performance.now();
		const lines = [`${formatDuration(this.lastRender - this.started)} · ${this.step}`];
		for (const [label, text] of this.activity) lines.push(`  ${label}: ${text}`);
		for (const notice of this.notices) lines.push(`  ! ${notice}`);
		this.emit(lines.join("\n"));
	}
}
