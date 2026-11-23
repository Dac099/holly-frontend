interface PackageWaveFallbackElements {
	section: HTMLElement;
	frontWave: SVGElement;
	backWave: SVGElement;
}

/**
 * Fallback JS parallax driver for browsers without CSS Scroll-Driven Animations
 * (`animation-timeline: view()` and `animation-range: entry`).
 */
export function initPackageWaveFallback({
	section,
	frontWave,
	backWave,
}: PackageWaveFallbackElements): () => void {
	const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	let prefersReducedMotion = reducedMotionQuery.matches;
	let disposed = false;
	let isActive = false;
	let rafId: number | null = null;

	const applyWavePosition = () => {
		rafId = null;
		if (disposed || prefersReducedMotion) return;

		const rect = section.getBoundingClientRect();
		const viewportHeight = window.innerHeight || 1;
		const raw = (viewportHeight - rect.top) / Math.max(1, rect.height + viewportHeight);
		const progress = Math.min(1, Math.max(0, raw));

		frontWave.style.transform = `translate3d(${(-50 * progress).toFixed(4)}%, 0, 0)`;
		backWave.style.transform = `translate3d(${(-44 + 38 * progress).toFixed(4)}%, 0, 0)`;
	};

	const scheduleUpdate = () => {
		if (disposed || prefersReducedMotion || rafId !== null) return;
		rafId = requestAnimationFrame(applyWavePosition);
	};

	const attachListeners = () => {
		if (isActive || prefersReducedMotion) return;
		isActive = true;
		window.addEventListener('scroll', scheduleUpdate, { passive: true });
		window.addEventListener('resize', scheduleUpdate, { passive: true });
	};

	const detachListeners = () => {
		if (!isActive) return;
		isActive = false;
		window.removeEventListener('scroll', scheduleUpdate);
		window.removeEventListener('resize', scheduleUpdate);
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	};

	const clearInlineTransforms = () => {
		frontWave.style.transform = '';
		backWave.style.transform = '';
	};

	const observer = new IntersectionObserver(
		(entries) => {
			if (disposed || prefersReducedMotion) return;
			const intersecting = entries.some((entry) => entry.isIntersecting);
			if (intersecting) {
				attachListeners();
				applyWavePosition();
			} else {
				detachListeners();
			}
		},
		{ rootMargin: '120px 0px', threshold: 0 },
	);

	const onReducedMotionChange = (event: MediaQueryListEvent) => {
		prefersReducedMotion = event.matches;
		if (prefersReducedMotion) {
			detachListeners();
			clearInlineTransforms();
		} else {
			attachListeners();
			applyWavePosition();
		}
	};

	observer.observe(section);
	reducedMotionQuery.addEventListener('change', onReducedMotionChange);

	if (!prefersReducedMotion) {
		applyWavePosition();
	}

	return () => {
		disposed = true;
		detachListeners();
		observer.disconnect();
		reducedMotionQuery.removeEventListener('change', onReducedMotionChange);
		clearInlineTransforms();
	};
}
