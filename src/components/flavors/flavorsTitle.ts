export interface FlavorsTitleElements {
	section: HTMLElement;
	header: HTMLElement;
	titleRow: HTMLElement;
	titleEl: HTMLElement;
	titleFixed: HTMLElement;
	viewport: HTMLElement;
	phrases: HTMLElement[];
}

export interface FlavorsTitleController {
	destroy: () => void;
}

interface PhraseMetrics {
	width: number;
	height: number;
}

const HOLD_MS = 1500;
const ANIM_MS = 250;

export function initFlavorsTitle({
	section,
	header,
	titleRow,
	titleEl,
	titleFixed,
	viewport,
	phrases,
}: FlavorsTitleElements): FlavorsTitleController {
	if (phrases.length <= 1) {
		return { destroy: () => {} };
	}

	const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	const cleanups: Array<() => void> = [];

	let metrics: PhraseMetrics[] = phrases.map(() => ({ width: 0, height: 0 }));
	let currentIndex = 0;
	let isVisible = true;
	let isReducedMotion = motionQuery.matches;
	let destroyed = false;

	let holdTimer: number | null = null;
	let animTimer: number | null = null;

	const clearTimers = () => {
		if (holdTimer !== null) {
			window.clearTimeout(holdTimer);
			holdTimer = null;
		}
		if (animTimer !== null) {
			window.clearTimeout(animTimer);
			animTimer = null;
		}
	};

	const canRun = () => !destroyed && !isReducedMotion && isVisible;

	const applySlotSize = (index: number) => {
		const metric = metrics[index];
		if (!metric || metric.width === 0 || metric.height === 0) return;
		viewport.style.setProperty('--slot-width', `${metric.width}px`);
		viewport.style.setProperty('--slot-height', `${metric.height}px`);
	};

	const measurePhrases = () => {
		if (destroyed) return;

		if (isReducedMotion) {
			viewport.removeAttribute('data-animated');
			viewport.style.removeProperty('--slot-width');
			viewport.style.removeProperty('--slot-height');
			titleEl.style.removeProperty('--title-max-w');
			titleRow.style.removeProperty('--header-min-h');
			return;
		}

		const headerStyle = getComputedStyle(header);
		const padLeft = parseFloat(headerStyle.paddingLeft) || 0;
		const padRight = parseFloat(headerStyle.paddingRight) || 0;
		const available = Math.max(
			220,
			Math.min(1120, header.clientWidth - padLeft - padRight),
		);

		titleEl.style.setProperty('--title-max-w', `${available}px`);
		viewport.dataset.animated = 'true';

		metrics = phrases.map((phrase) => {
			const rect = phrase.getBoundingClientRect();
			return {
				width: Math.ceil(rect.width),
				height: Math.ceil(rect.height),
			};
		});

		const titleStyle = getComputedStyle(titleEl);
		const columnGap = parseFloat(titleStyle.columnGap) || 0;
		const rowGap = parseFloat(titleStyle.rowGap) || 0;
		const fixedRect = titleFixed.getBoundingClientRect();

		let maxHeaderHeight = fixedRect.height;
		for (const metric of metrics) {
			const fitsSameLine =
				fixedRect.width + columnGap + metric.width <= available + 1;
			const lineHeight = fitsSameLine
				? Math.max(fixedRect.height, metric.height)
				: fixedRect.height + rowGap + metric.height;
			if (lineHeight > maxHeaderHeight) {
				maxHeaderHeight = lineHeight;
			}
		}

		titleRow.style.setProperty('--header-min-h', `${Math.ceil(maxHeaderHeight)}px`);
		applySlotSize(currentIndex);
	};

	const resetToFirstPhrase = () => {
		clearTimers();
		currentIndex = 0;
		phrases.forEach((phrase, index) => {
			phrase.dataset.state = index === 0 ? 'active' : 'waiting';
		});
		measurePhrases();
	};

	const scheduleNext = () => {
		clearTimers();
		if (!canRun()) return;
		holdTimer = window.setTimeout(advancePhrase, HOLD_MS);
	};

	const advancePhrase = () => {
		holdTimer = null;
		if (!canRun()) return;

		const prevIndex = currentIndex;
		const nextIndex = (currentIndex + 1) % phrases.length;
		const prevPhrase = phrases[prevIndex];
		const nextPhrase = phrases[nextIndex];

		nextPhrase.dataset.state = 'entering';
		// Commit starting transform before animating to active
		void nextPhrase.offsetHeight;

		prevPhrase.dataset.state = 'exiting';
		nextPhrase.dataset.state = 'active';
		currentIndex = nextIndex;
		applySlotSize(nextIndex);

		animTimer = window.setTimeout(() => {
			animTimer = null;
			if (destroyed) return;
			prevPhrase.dataset.state = 'waiting';
			scheduleNext();
		}, ANIM_MS);
	};

	const handleStateChange = () => {
		if (canRun()) {
			if (holdTimer === null && animTimer === null) {
				scheduleNext();
			}
		} else {
			if (holdTimer !== null) {
				window.clearTimeout(holdTimer);
				holdTimer = null;
			}
		}
	};

	const onMotionChange = (event: MediaQueryListEvent) => {
		isReducedMotion = event.matches;
		if (isReducedMotion) {
			resetToFirstPhrase();
		} else {
			measurePhrases();
			scheduleNext();
		}
	};

	motionQuery.addEventListener('change', onMotionChange);

	cleanups.push(() => {
		motionQuery.removeEventListener('change', onMotionChange);
	});

	if (typeof ResizeObserver !== 'undefined') {
		const resizeObserver = new ResizeObserver(() => {
			measurePhrases();
		});
		resizeObserver.observe(header);
		cleanups.push(() => resizeObserver.disconnect());
	}

	if (typeof IntersectionObserver !== 'undefined') {
		const visibilityObserver = new IntersectionObserver(
			(entries) => {
				isVisible = entries.some((entry) => entry.isIntersecting);
				handleStateChange();
			},
			{ threshold: 0.1 },
		);
		visibilityObserver.observe(section);
		cleanups.push(() => visibilityObserver.disconnect());
	}

	measurePhrases();

	if (document.fonts?.ready) {
		void document.fonts.ready.then(() => {
			if (!destroyed) {
				measurePhrases();
			}
		});
	}

	scheduleNext();

	return {
		destroy: () => {
			destroyed = true;
			clearTimers();
			while (cleanups.length > 0) {
				cleanups.pop()?.();
			}
		},
	};
}
