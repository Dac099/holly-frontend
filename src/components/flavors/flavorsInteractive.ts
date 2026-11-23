export interface FlavorsInteractiveElements {
	section: HTMLElement;
	carousel: HTMLElement;
	track: HTMLElement;
	slides: HTMLElement[];
	prevBtn: HTMLButtonElement;
	nextBtn: HTMLButtonElement;
	markersNav: HTMLElement;
	statusRegion: HTMLElement;
}

export interface FlavorsInteractiveController {
	destroy: () => void;
}

interface SlideBinding {
	slide: HTMLElement;
	stage: HTMLElement;
	trigger: HTMLButtonElement;
	card: HTMLElement;
	salsaName: string;
}

const CAROUSEL_MEDIA = '(max-width: 1023px)';
const SETTLE_FALLBACK_MS = 140;

export function initFlavorsInteractive({
	section,
	carousel,
	track,
	slides,
	prevBtn,
	nextBtn,
	markersNav,
	statusRegion,
}: FlavorsInteractiveElements): FlavorsInteractiveController {
	const carouselQuery = window.matchMedia(CAROUSEL_MEDIA);
	const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	const supportsScrollEnd = 'onscrollend' in window;
	const supportsSiblingCount =
		typeof window.CSS?.supports === 'function' &&
		window.CSS.supports('order', 'sibling-count()');

	const bindings: SlideBinding[] = slides.map((slide) => {
		const stage = slide.querySelector<HTMLElement>('[data-bottle-stage]')!;
		const trigger = slide.querySelector<HTMLButtonElement>('[data-bottle-trigger]')!;
		const card = slide.querySelector<HTMLElement>('[data-info-card]')!;
		return {
			slide,
			stage,
			trigger,
			card,
			salsaName: slide.dataset.salsaName || '',
		};
	});

	const markerButtons: HTMLButtonElement[] = [];
	const cleanups: Array<() => void> = [];

	let isCarouselMode = false;
	let pinnedIndex: number | null = null;
	let activeIndex = 0;
	let lastAnnouncedIndex = 0;
	let pendingTarget: number | null = null;
	let inDomOrderTrip = false;
	let queuedDirection: -1 | 1 | null = null;
	let scrollRequestStartLeft = 0;
	let scrollRafId: number | null = null;
	let fallbackSettleTimer: number | null = null;
	let overflowReleaseRaf1: number | null = null;
	let overflowReleaseRaf2: number | null = null;

	const clearOverflowRelease = () => {
		if (overflowReleaseRaf1 !== null) {
			cancelAnimationFrame(overflowReleaseRaf1);
			overflowReleaseRaf1 = null;
		}
		if (overflowReleaseRaf2 !== null) {
			cancelAnimationFrame(overflowReleaseRaf2);
			overflowReleaseRaf2 = null;
		}
	};

	const setPinned = (nextIndex: number | null, suppressHoverOnClose = false) => {
		if (pinnedIndex !== null && pinnedIndex !== nextIndex) {
			const prev = bindings[pinnedIndex];
			prev.stage.dataset.pinned = 'false';
			prev.trigger.setAttribute('aria-expanded', 'false');
			prev.card.setAttribute('aria-hidden', 'true');
			if (suppressHoverOnClose) {
				prev.stage.dataset.hoverSuppressed = 'true';
			}
		}

		if (nextIndex !== null) {
			const next = bindings[nextIndex];
			delete next.stage.dataset.hoverSuppressed;
			next.stage.dataset.pinned = 'true';
			next.trigger.setAttribute('aria-expanded', 'true');
			next.card.setAttribute('aria-hidden', 'false');
		}

		pinnedIndex = nextIndex;
	};

	const buildMarkers = () => {
		if (markerButtons.length > 0) return;

		for (let i = 0; i < bindings.length; i += 1) {
			const { slide, salsaName } = bindings[i];
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.setAttribute('aria-label', slide.dataset.markerName || `Ir a ${salsaName}`);
			btn.setAttribute('aria-current', i === activeIndex ? 'true' : 'false');
			btn.addEventListener('click', () => {
				if (!isCarouselMode) return;
				scrollToMarker(i);
			});
			markersNav.appendChild(btn);
			markerButtons.push(btn);
		}
	};

	const syncMarkers = (currentIdx: number) => {
		for (let i = 0; i < markerButtons.length; i += 1) {
			markerButtons[i].setAttribute(
				'aria-current',
				i === currentIdx ? 'true' : 'false',
			);
		}
		for (let i = 0; i < bindings.length; i += 1) {
			bindings[i].slide.dataset.active = i === currentIdx ? 'true' : 'false';
		}
	};

	const getSlideCenterDelta = (index: number): number => {
		const trackRect = track.getBoundingClientRect();
		const slideRect = bindings[index].slide.getBoundingClientRect();
		return (
			slideRect.left +
			slideRect.width / 2 -
			(trackRect.left + trackRect.width / 2)
		);
	};

	const getNearestSlideIndex = (): number => {
		let bestIndex = activeIndex;
		let bestDist = Infinity;
		for (let i = 0; i < bindings.length; i += 1) {
			const dist = Math.abs(getSlideCenterDelta(i));
			if (dist < bestDist) {
				bestDist = dist;
				bestIndex = i;
			}
		}
		return bestIndex;
	};

	const getVisualOrder = (): number[] => {
		return bindings
			.map((binding, index) => ({
				index,
				left: binding.slide.getBoundingClientRect().left,
			}))
			.sort((a, b) => a.left - b.left)
			.map((item) => item.index);
	};

	const applyOrderWithCompensation = (
		referenceIndex: number,
		nextCurrent: string | null,
		lockOverflow: boolean,
	) => {
		const currentProp = track.style.getPropertyValue('--current');
		if ((nextCurrent ?? '') === currentProp) {
			return;
		}

		clearOverflowRelease();
		const prevLeft = bindings[referenceIndex].slide.getBoundingClientRect().left;
		const prevSnap = track.style.scrollSnapType;
		const prevBehavior = track.style.scrollBehavior;

		track.style.scrollSnapType = 'none';
		track.style.scrollBehavior = 'auto';
		if (lockOverflow) {
			track.style.overflowX = 'hidden';
		}

		if (nextCurrent === null) {
			track.style.removeProperty('--current');
		} else {
			track.style.setProperty('--current', nextCurrent);
		}

		const nextLeft = bindings[referenceIndex].slide.getBoundingClientRect().left;
		const diff = nextLeft - prevLeft;
		const didShift = Math.abs(diff) > 0.5;
		if (didShift) {
			track.scrollLeft += diff;
			void track.scrollLeft;
		}

		track.style.scrollSnapType = prevSnap;
		track.style.scrollBehavior = prevBehavior;

		if (lockOverflow && didShift) {
			overflowReleaseRaf1 = requestAnimationFrame(() => {
				overflowReleaseRaf1 = null;
				overflowReleaseRaf2 = requestAnimationFrame(() => {
					overflowReleaseRaf2 = null;
					track.style.overflowX = '';
				});
			});
		} else if (lockOverflow) {
			track.style.overflowX = '';
		}
	};

	const scrollByTarget = (targetIndex: number) => {
		const delta = getSlideCenterDelta(targetIndex);
		if (Math.abs(delta) < 1) {
			return false;
		}

		const instant = motionQuery.matches;
		scrollRequestStartLeft = track.scrollLeft;
		pendingTarget = targetIndex;
		syncMarkers(targetIndex);

		track.scrollBy({
			left: delta,
			behavior: instant ? 'instant' : 'smooth',
		});

		if (instant) {
			requestAnimationFrame(() => {
				if (isCarouselMode) {
					onSettle();
				}
			});
		}

		return true;
	};

	const scrollStep = (direction: -1 | 1) => {
		if (!isCarouselMode) return;

		if (inDomOrderTrip) {
			queuedDirection = direction;
			return;
		}

		const baseIndex = pendingTarget ?? activeIndex;
		const visualOrder = getVisualOrder();
		const visualPos = visualOrder.indexOf(baseIndex);
		if (visualPos === -1) return;

		const nextVisualPos = visualPos + direction;
		if (nextVisualPos < 1 || nextVisualPos > visualOrder.length - 2) {
			queuedDirection = direction;
			return;
		}

		const targetIndex = visualOrder[nextVisualPos];
		scrollByTarget(targetIndex);
	};

	const scrollToMarker = (targetIndex: number) => {
		if (!isCarouselMode) return;
		const currentDisplayed = pendingTarget ?? activeIndex;
		if (targetIndex === currentDisplayed) return;

		queuedDirection = null;

		const visualOrder = getVisualOrder();
		const targetVisualPos = visualOrder.indexOf(targetIndex);
		if (targetVisualPos >= 1 && targetVisualPos <= bindings.length - 2) {
			inDomOrderTrip = false;
			scrollByTarget(targetIndex);
			return;
		}

		let prepCurrent: string | null = null;
		if (targetIndex === 0) {
			prepCurrent = '1';
		} else if (targetIndex === bindings.length - 1) {
			prepCurrent = String(bindings.length - 2);
		} else if (activeIndex === 0 && targetIndex <= bindings.length - 3) {
			prepCurrent = '1';
		} else if (activeIndex === bindings.length - 1 && targetIndex >= 2) {
			prepCurrent = String(bindings.length - 2);
		}

		inDomOrderTrip = true;

		// Reorder without overflow lock so Safari starts the scroll and the target sits in a centerable slot
		applyOrderWithCompensation(activeIndex, prepCurrent, false);
		if (!scrollByTarget(targetIndex)) {
			inDomOrderTrip = false;
			applyOrderWithCompensation(targetIndex, String(targetIndex), false);
		}
	};

	const onSettle = () => {
		if (!isCarouselMode) return;

		if (
			pendingTarget !== null &&
			Math.abs(track.scrollLeft - scrollRequestStartLeft) < 1 &&
			Math.abs(getSlideCenterDelta(pendingTarget)) > 4
		) {
			return;
		}

		const settledIndex = getNearestSlideIndex();
		const hasQueuedStep = queuedDirection !== null;
		const directionToReplay = queuedDirection;

		pendingTarget = null;
		inDomOrderTrip = false;
		queuedDirection = null;

		if (pinnedIndex !== null && pinnedIndex !== settledIndex) {
			setPinned(null);
		}

		activeIndex = settledIndex;
		syncMarkers(settledIndex);

		// Skip overflow lock when immediately replaying a queued step
		applyOrderWithCompensation(
			settledIndex,
			String(settledIndex),
			!hasQueuedStep,
		);

		if (settledIndex !== lastAnnouncedIndex) {
			lastAnnouncedIndex = settledIndex;
			statusRegion.textContent = `Salsa ${settledIndex + 1} de ${bindings.length}: ${bindings[settledIndex].salsaName}`;
		}

		if (directionToReplay !== null) {
			scrollStep(directionToReplay);
		}
	};

	const onTrackScroll = () => {
		if (!isCarouselMode) return;

		if (pendingTarget === null) {
			if (scrollRafId === null) {
				scrollRafId = requestAnimationFrame(() => {
					scrollRafId = null;
					if (!isCarouselMode || pendingTarget !== null) return;
					const nearest = getNearestSlideIndex();
					if (nearest !== activeIndex) {
						activeIndex = nearest;
						syncMarkers(nearest);
					}
				});
			}
		}

		if (!supportsScrollEnd) {
			if (fallbackSettleTimer !== null) {
				window.clearTimeout(fallbackSettleTimer);
			}
			fallbackSettleTimer = window.setTimeout(() => {
				fallbackSettleTimer = null;
				onSettle();
			}, SETTLE_FALLBACK_MS);
		}
	};

	const centerSlideInstantly = (index: number) => {
		const prevBehavior = track.style.scrollBehavior;
		const prevSnap = track.style.scrollSnapType;
		track.style.scrollBehavior = 'auto';
		track.style.scrollSnapType = 'none';
		const delta = getSlideCenterDelta(index);
		if (Math.abs(delta) > 0.5) {
			track.scrollLeft += delta;
			void track.scrollLeft;
		}
		track.style.scrollSnapType = prevSnap;
		track.style.scrollBehavior = prevBehavior;
	};

	const enterCarouselMode = () => {
		if (isCarouselMode) return;
		isCarouselMode = true;

		buildMarkers();

		carousel.setAttribute('role', 'region');
		carousel.setAttribute('aria-roledescription', 'carousel');
		carousel.setAttribute(
			'aria-label',
			carousel.dataset.carouselLabel || 'Sabores de Holly Salsa',
		);

		track.tabIndex = 0;
		track.setAttribute('role', 'group');
		track.setAttribute('aria-label', 'Botellas de salsa');

		for (let i = 0; i < bindings.length; i += 1) {
			const { slide } = bindings[i];
			slide.setAttribute('role', 'group');
			slide.setAttribute('aria-roledescription', 'diapositiva');
			slide.setAttribute('aria-label', `${i + 1} de ${bindings.length}`);
		}

		if (!supportsSiblingCount) {
			track.style.setProperty('--children-count', String(bindings.length));
		}

		activeIndex = pinnedIndex ?? 0;
		lastAnnouncedIndex = activeIndex;
		pendingTarget = null;
		inDomOrderTrip = false;
		queuedDirection = null;
		statusRegion.textContent = '';

		track.style.setProperty('--current', String(activeIndex));
		syncMarkers(activeIndex);
		centerSlideInstantly(activeIndex);

		requestAnimationFrame(() => {
			if (!isCarouselMode) return;
			centerSlideInstantly(activeIndex);
		});
	};

	const exitCarouselMode = () => {
		if (!isCarouselMode) return;
		isCarouselMode = false;

		clearOverflowRelease();
		if (scrollRafId !== null) {
			cancelAnimationFrame(scrollRafId);
			scrollRafId = null;
		}
		if (fallbackSettleTimer !== null) {
			window.clearTimeout(fallbackSettleTimer);
			fallbackSettleTimer = null;
		}

		pendingTarget = null;
		inDomOrderTrip = false;
		queuedDirection = null;

		carousel.removeAttribute('role');
		carousel.removeAttribute('aria-roledescription');
		carousel.removeAttribute('aria-label');

		track.removeAttribute('tabindex');
		track.removeAttribute('role');
		track.removeAttribute('aria-label');
		track.style.removeProperty('--current');
		track.style.removeProperty('--children-count');
		track.style.overflowX = '';
		track.scrollLeft = 0;

		for (let i = 0; i < bindings.length; i += 1) {
			const { slide } = bindings[i];
			slide.removeAttribute('role');
			slide.removeAttribute('aria-roledescription');
			slide.removeAttribute('aria-label');
			slide.dataset.active = 'true';
		}

		statusRegion.textContent = '';
	};

	const syncViewportMode = () => {
		if (carouselQuery.matches) {
			enterCarouselMode();
		} else {
			exitCarouselMode();
		}
	};

	bindings.forEach(({ stage, trigger }, index) => {
		const onTriggerClick = () => {
			if (isCarouselMode && index !== activeIndex) {
				const visualOrder = getVisualOrder();
				const targetVisual = visualOrder.indexOf(index);
				const currentVisual = visualOrder.indexOf(activeIndex);
				if (targetVisual !== -1 && currentVisual !== -1) {
					if (Math.abs(targetVisual - currentVisual) === 1) {
						scrollStep(targetVisual > currentVisual ? 1 : -1);
					} else {
						scrollToMarker(index);
					}
				}
				return;
			}

			if (pinnedIndex === index) {
				setPinned(null, true);
			} else {
				setPinned(index);
			}
		};

		const onPointerLeave = () => {
			delete stage.dataset.hoverSuppressed;
		};

		trigger.addEventListener('click', onTriggerClick);
		stage.addEventListener('pointerleave', onPointerLeave);
		cleanups.push(() => {
			trigger.removeEventListener('click', onTriggerClick);
			stage.removeEventListener('pointerleave', onPointerLeave);
		});
	});

	const onPrevClick = () => scrollStep(-1);
	const onNextClick = () => scrollStep(1);
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && pinnedIndex !== null) {
			setPinned(null, true);
		}
	};
	const onMediaChange = () => syncViewportMode();

	prevBtn.addEventListener('click', onPrevClick);
	nextBtn.addEventListener('click', onNextClick);
	track.addEventListener('scroll', onTrackScroll, { passive: true });
	if (supportsScrollEnd) {
		track.addEventListener('scrollend', onSettle);
	}
	section.addEventListener('keydown', onKeyDown);
	carouselQuery.addEventListener('change', onMediaChange);

	cleanups.push(() => {
		prevBtn.removeEventListener('click', onPrevClick);
		nextBtn.removeEventListener('click', onNextClick);
		track.removeEventListener('scroll', onTrackScroll);
		if (supportsScrollEnd) {
			track.removeEventListener('scrollend', onSettle);
		}
		section.removeEventListener('keydown', onKeyDown);
		carouselQuery.removeEventListener('change', onMediaChange);
	});

	syncViewportMode();

	return {
		destroy: () => {
			exitCarouselMode();
			setPinned(null);
			while (cleanups.length > 0) {
				cleanups.pop()?.();
			}
		},
	};
}
