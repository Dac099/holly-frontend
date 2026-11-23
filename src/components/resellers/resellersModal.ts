export interface ResellersModalElements {
	dialog: HTMLDialogElement;
	image: HTMLImageElement;
	cards: HTMLElement[];
}

export interface ResellersModalOpenOptions {
	defer?: boolean;
}

export interface ResellersModalController {
	openCard: (card: HTMLElement, options?: ResellersModalOpenOptions) => void;
	destroy: () => void;
}

const STATIC_TOUCH_MOVE_PX = 14;
const STATIC_DOUBLE_TAP_DELAY_MS = 420;
const STATIC_DOUBLE_TAP_MAX_DIST_PX = 44;

let cachedCanTransitionDisplay: boolean | undefined;

function canTransitionDisplay(): boolean {
	if (cachedCanTransitionDisplay !== undefined) {
		return cachedCanTransitionDisplay;
	}
	if (typeof window === 'undefined' || !document.body) {
		return false;
	}
	if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete')) {
		cachedCanTransitionDisplay = false;
		return false;
	}

	const probe = document.createElement('div');
	probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
	document.body.appendChild(probe);
	getComputedStyle(probe).display;
	probe.style.display = 'none';
	cachedCanTransitionDisplay = getComputedStyle(probe).display === 'block';
	probe.remove();
	return cachedCanTransitionDisplay;
}

function supportsTopLayerExit(): boolean {
	return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

function isPointerOutsideDialog(event: PointerEvent, dialog: HTMLDialogElement): boolean {
	const rect = dialog.getBoundingClientRect();
	return (
		event.clientX < rect.left ||
		event.clientX > rect.right ||
		event.clientY < rect.top ||
		event.clientY > rect.bottom
	);
}

async function closeTopLayer(dialog: HTMLDialogElement): Promise<void> {
	if (!dialog.open) return;

	if (!supportsTopLayerExit()) {
		dialog.setAttribute('data-closing', '');
		const animations = dialog.getAnimations({ subtree: true });
		if (animations.length > 0) {
			await Promise.race([
				Promise.allSettled(animations.map((animation) => animation.finished)),
				new Promise<void>((resolve) => {
					window.setTimeout(resolve, 400);
				}),
			]);
		}
		if (!dialog.hasAttribute('data-closing')) return;
		dialog.removeAttribute('data-closing');
	}

	if (dialog.open) {
		dialog.close();
	}
}

export function initResellersModal({
	dialog,
	image,
	cards,
}: ResellersModalElements): ResellersModalController {
	const cleanups: Array<() => void> = [];
	let pressedOutside = false;
	let deferredOpenTimer: number | null = null;
	let staticTouchStart: { card: HTMLElement; pointerId: number; x: number; y: number } | null = null;
	let staticLastTap: { card: HTMLElement; time: number; x: number; y: number } | null = null;

	const clearDeferredOpen = () => {
		if (deferredOpenTimer !== null) {
			window.clearTimeout(deferredOpenTimer);
			deferredOpenTimer = null;
		}
	};

	const openCard = (card: HTMLElement, options?: ResellersModalOpenOptions) => {
		clearDeferredOpen();
		if (options?.defer) {
			deferredOpenTimer = window.setTimeout(() => {
				deferredOpenTimer = null;
				openCard(card);
			}, 0);
			return;
		}

		if (dialog.open) return;

		const cardImage = card.querySelector<HTMLImageElement>('img');
		if (!cardImage) return;

		image.src = cardImage.currentSrc || cardImage.src;
		image.alt = cardImage.alt;
		dialog.setAttribute(
			'aria-label',
			card.dataset.reviewLabel || cardImage.alt || 'Vista ampliada de la reseña',
		);

		dialog.removeAttribute('data-closing');
		dialog.showModal();
	};

	const onDialogClose = () => {
		clearDeferredOpen();
		dialog.returnValue = '';
		dialog.removeAttribute('data-closing');
	};

	const onDialogCancel = (event: Event) => {
		if (supportsTopLayerExit()) return;
		if (dialog.hasAttribute('data-closing')) return;
		event.preventDefault();
		void closeTopLayer(dialog);
	};

	const modalForm = dialog.querySelector<HTMLFormElement>('form[method="dialog"]');
	const onFormSubmit = (event: SubmitEvent) => {
		if (supportsTopLayerExit()) return;
		event.preventDefault();
		void closeTopLayer(dialog);
	};

	dialog.addEventListener('close', onDialogClose);
	dialog.addEventListener('cancel', onDialogCancel);
	cleanups.push(() => {
		dialog.removeEventListener('close', onDialogClose);
		dialog.removeEventListener('cancel', onDialogCancel);
	});

	if (modalForm) {
		modalForm.addEventListener('submit', onFormSubmit);
		cleanups.push(() => {
			modalForm.removeEventListener('submit', onFormSubmit);
		});
	}

	// Fallback light-dismiss for browsers without native closedby="any" (e.g. Safari)
	if (!('closedBy' in HTMLDialogElement.prototype)) {
		const onPointerDown = (event: PointerEvent) => {
			pressedOutside = isPointerOutsideDialog(event, dialog);
		};
		const onPointerUp = (event: PointerEvent) => {
			if (pressedOutside && isPointerOutsideDialog(event, dialog)) {
				void closeTopLayer(dialog);
			}
			pressedOutside = false;
		};
		dialog.addEventListener('pointerdown', onPointerDown);
		dialog.addEventListener('pointerup', onPointerUp);
		cleanups.push(() => {
			dialog.removeEventListener('pointerdown', onPointerDown);
			dialog.removeEventListener('pointerup', onPointerUp);
		});
	}

	for (const card of cards) {
		if (!card.hasAttribute('tabindex')) {
			card.tabIndex = 0;
		}
		if (!card.hasAttribute('aria-label')) {
			const label = card.dataset.reviewLabel || 'Reseña';
			card.setAttribute('aria-label', `${label}. Pulsa Enter o haz doble clic para ampliar.`);
		}

		const onDblClick = () => {
			if (card.dataset.dragging === 'true') return;
			const lastDragAt = Number(card.dataset.lastDragAt || 0);
			if (lastDragAt > 0 && Date.now() - lastDragAt < 250) return;
			openCard(card);
		};

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			event.preventDefault();
			openCard(card);
		};

		const onPointerDown = (event: PointerEvent) => {
			if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) return;
			if (card.closest('[data-physics-active="true"]')) return;
			staticTouchStart = {
				card,
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
		};

		const onPointerUp = (event: PointerEvent) => {
			if (!staticTouchStart || staticTouchStart.card !== card || staticTouchStart.pointerId !== event.pointerId) {
				return;
			}
			const start = staticTouchStart;
			staticTouchStart = null;
			if (card.closest('[data-physics-active="true"]')) return;
			if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > STATIC_TOUCH_MOVE_PX) {
				staticLastTap = null;
				return;
			}

			const now = Date.now();
			const isDoubleTap =
				staticLastTap !== null &&
				staticLastTap.card === card &&
				now - staticLastTap.time <= STATIC_DOUBLE_TAP_DELAY_MS &&
				Math.hypot(event.clientX - staticLastTap.x, event.clientY - staticLastTap.y) <= STATIC_DOUBLE_TAP_MAX_DIST_PX;

			if (isDoubleTap) {
				staticLastTap = null;
				openCard(card, { defer: true });
			} else {
				staticLastTap = {
					card,
					time: now,
					x: event.clientX,
					y: event.clientY,
				};
			}
		};

		const onPointerCancel = (event: PointerEvent) => {
			if (staticTouchStart?.card === card && staticTouchStart.pointerId === event.pointerId) {
				staticTouchStart = null;
			}
		};

		card.addEventListener('pointerdown', onPointerDown);
		card.addEventListener('pointerup', onPointerUp);
		card.addEventListener('pointercancel', onPointerCancel);
		card.addEventListener('dblclick', onDblClick);
		card.addEventListener('keydown', onKeyDown);
		cleanups.push(() => {
			card.removeEventListener('pointerdown', onPointerDown);
			card.removeEventListener('pointerup', onPointerUp);
			card.removeEventListener('pointercancel', onPointerCancel);
			card.removeEventListener('dblclick', onDblClick);
			card.removeEventListener('keydown', onKeyDown);
		});
	}

	return {
		openCard,
		destroy: () => {
			clearDeferredOpen();
			while (cleanups.length > 0) {
				cleanups.pop()?.();
			}
		},
	};
}
