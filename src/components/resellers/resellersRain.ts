import Matter from 'matter-js';

export interface ResellersRainElements {
	section: HTMLElement;
	stage: HTMLElement;
	field: HTMLElement;
	hint: HTMLElement | null;
	liveRegion: HTMLElement | null;
	cards: HTMLElement[];
	onOpenReview?: (card: HTMLElement) => void;
}

interface ContentVisibilityEvent extends Event {
	skipped: boolean;
}

interface CardDimensions {
	w: number;
	h: number;
}

interface ReviewCardState {
	index: number;
	el: HTMLElement;
	aspect: number;
	label: string;
	size: CardDimensions;
	body: Matter.Body | null;
	spawned: boolean;
	enteredStage: boolean;
}

interface ActiveDrag {
	card: ReviewCardState;
	pointerId: number;
	constraint: Matter.Constraint;
}

interface PendingDrag {
	card: ReviewCardState;
	pointerId: number;
	startX: number;
	startY: number;
	threshold: number;
}

interface TapRecord {
	card: ReviewCardState;
	time: number;
	x: number;
	y: number;
}

const FIXED_STEP_MS = 1000 / 60;
const MAX_FRAME_DELTA_MS = 50;
const WALL_THICKNESS = 80;
const INITIAL_FALL_SPEED = 3.5;
const MAX_RELEASE_SPEED = 18;
const CARD_CHAMFER_RADIUS = 12;
const MOUSE_DRAG_THRESHOLD_PX = 4;
const TOUCH_DRAG_THRESHOLD_PX = 14;
const DOUBLE_TAP_DELAY_MS = 420;
const DOUBLE_TAP_MAX_DIST_PX = 44;

// Staggered release delays (ms) and interleaved horizontal lane indices
const SPAWN_DELAYS_MS = [0, 260, 540, 820, 1100];
const LANE_ORDER = [1, 3, 0, 4, 2];
const INITIAL_TILTS = [-0.1, 0.08, -0.06, 0.11, -0.08];

const CARD_BODY_OPTIONS: Matter.IBodyDefinition = {
	density: 0.002,
	frictionAir: 0.015,
	restitution: 0.28,
	friction: 0.55,
	frictionStatic: 0.7,
	sleepThreshold: 45,
};

const WALL_OPTIONS: Matter.IBodyDefinition = {
	isStatic: true,
	restitution: 0.25,
	friction: 0.6,
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function computeCardDimensions(
	aspect: number,
	stageWidth: number,
	stageHeight: number,
): CardDimensions {
	const isMobile = stageWidth < 720;
	const stageArea = Math.max(1, stageWidth * stageHeight);
	const fillRatio = isMobile ? 0.28 : 0.24;
	const targetCardArea = (stageArea * fillRatio) / 5;

	const idealW = Math.sqrt(targetCardArea * aspect);
	const idealH = idealW / aspect;

	const maxW = isMobile ? stageWidth * 0.42 : Math.min(stageWidth * 0.24, 290);
	const maxH = isMobile ? stageHeight * 0.32 : Math.min(stageHeight * 0.42, 340);
	const minW = isMobile ? 76 : 96;

	// Uniform scaling preserves exact intrinsic aspect ratio for isotropic Body.scale
	const downScale = Math.min(1, maxW / idealW, maxH / idealH);
	let w = idealW * downScale;
	let h = idealH * downScale;

	if (w < minW && maxW >= minW) {
		const upScale = Math.min(minW / w, maxW / w, maxH / h);
		w *= upScale;
		h *= upScale;
	}

	return {
		w: Math.round(w),
		h: Math.round(h),
	};
}

function clampVelocity(body: Matter.Body, maxSpeed: number): void {
	const speed = Math.hypot(body.velocity.x, body.velocity.y);
	if (speed <= maxSpeed || speed === 0) return;
	const ratio = maxSpeed / speed;
	Matter.Body.setVelocity(body, {
		x: body.velocity.x * ratio,
		y: body.velocity.y * ratio,
	});
}

export function initResellersRain({
	section,
	stage,
	field,
	hint,
	liveRegion,
	cards: cardElements,
	onOpenReview,
}: ResellersRainElements): () => void {
	const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	let prefersReducedMotion = reducedMotionQuery.matches;

	let disposed = false;
	let physicsInitialized = false;
	let hasDropped = false;
	let hasInteracted = false;
	let ceilingAdded = false;
	let isSkipped = false;

	let stageWidth = 0;
	let stageHeight = 0;
	let topZIndex = 10;

	let engine: Matter.Engine | null = null;
	let staticWalls: Matter.Body[] = [];
	let ceilingWall: Matter.Body | null = null;
	let activeDrag: ActiveDrag | null = null;
	let pendingDrag: PendingDrag | null = null;
	let lastTap: TapRecord | null = null;

	let rafId: number | null = null;
	let lastFrameTime = 0;
	let accumulatorMs = 0;
	let liveClearTimer: number | null = null;
	const spawnTimers: number[] = [];

	const cardStates: ReviewCardState[] = cardElements.map((el, index) => {
		const parsedAspect = Number(el.dataset.aspect);
		const aspect = Number.isFinite(parsedAspect) && parsedAspect > 0 ? parsedAspect : 0.75;
		const label = el.dataset.reviewLabel || `Reseña ${index + 1}`;
		return {
			index,
			el,
			aspect,
			label,
			size: { w: 160, h: Math.round(160 / aspect) },
			body: null,
			spawned: false,
			enteredStage: false,
		};
	});

	let visibilityTriggerObserver: IntersectionObserver | null = null;
	let fallbackVisibilityObserver: IntersectionObserver | null = null;

	const stopLoop = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		lastFrameTime = 0;
	};

	const clearSpawnTimers = () => {
		while (spawnTimers.length > 0) {
			const id = spawnTimers.pop();
			if (id !== undefined) {
				window.clearTimeout(id);
			}
		}
	};

	const setHintVisible = (visible: boolean) => {
		if (!hint) return;
		const next = visible ? 'true' : 'false';
		if (hint.dataset.visible !== next) {
			hint.dataset.visible = next;
		}
	};

	const markInteracted = () => {
		if (hasInteracted) return;
		hasInteracted = true;
		setHintVisible(false);
	};

	const announceMove = (label: string, directionText: string) => {
		if (!liveRegion) return;
		liveRegion.textContent = `${label} ${directionText}`;
		if (liveClearTimer !== null) {
			window.clearTimeout(liveClearTimer);
		}
		liveClearTimer = window.setTimeout(() => {
			if (liveRegion) liveRegion.textContent = '';
			liveClearTimer = null;
		}, 1000);
	};

	const wakeAllBodies = () => {
		for (const state of cardStates) {
			if (state.body) {
				Matter.Sleeping.set(state.body, false);
			}
		}
	};

	const applyCardSizeToElement = (state: ReviewCardState) => {
		state.el.style.width = `${state.size.w}px`;
		state.el.style.height = `${state.size.h}px`;
	};

	const renderCards = () => {
		for (const state of cardStates) {
			if (!state.body || !state.spawned) continue;
			const x = state.body.position.x - state.size.w / 2;
			const y = state.body.position.y - state.size.h / 2;
			state.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${state.body.angle.toFixed(4)}rad)`;
		}
	};

	const rebuildBoundaries = () => {
		if (!engine) return;

		if (staticWalls.length > 0) {
			Matter.Composite.remove(engine.world, staticWalls);
			staticWalls = [];
		}
		if (ceilingWall) {
			Matter.Composite.remove(engine.world, ceilingWall);
			ceilingWall = null;
		}

		const halfWall = WALL_THICKNESS / 2;
		const verticalSpan = stageHeight + WALL_THICKNESS * 10;
		const verticalCenterY = stageHeight / 2 - WALL_THICKNESS * 3;
		const horizontalSpan = stageWidth + WALL_THICKNESS * 2;

		const floor = Matter.Bodies.rectangle(
			stageWidth / 2,
			stageHeight + halfWall,
			horizontalSpan,
			WALL_THICKNESS,
			WALL_OPTIONS,
		);
		const leftWall = Matter.Bodies.rectangle(
			-halfWall,
			verticalCenterY,
			WALL_THICKNESS,
			verticalSpan,
			WALL_OPTIONS,
		);
		const rightWall = Matter.Bodies.rectangle(
			stageWidth + halfWall,
			verticalCenterY,
			WALL_THICKNESS,
			verticalSpan,
			WALL_OPTIONS,
		);

		staticWalls = [floor, leftWall, rightWall];
		Matter.Composite.add(engine.world, staticWalls);

		if (ceilingAdded) {
			ceilingWall = Matter.Bodies.rectangle(
				stageWidth / 2,
				-halfWall,
				horizontalSpan,
				WALL_THICKNESS,
				WALL_OPTIONS,
			);
			Matter.Composite.add(engine.world, ceilingWall);
		}
	};

	const maybeActivateCeiling = () => {
		if (ceilingAdded || !engine) return;
		if (!cardStates.every((state) => state.spawned && state.body)) return;

		let allEntered = true;
		for (const state of cardStates) {
			if (!state.body) continue;
			const topEdge = state.body.position.y - state.size.h / 2;
			if (topEdge >= 4) {
				state.enteredStage = true;
			}
			if (!state.enteredStage) {
				allEntered = false;
			}
		}

		const allSleeping = cardStates.every((state) => Boolean(state.body?.isSleeping));
		if (!allEntered && !allSleeping) return;

		// Ensure no body clips into the top ceiling before placing it
		for (const state of cardStates) {
			if (!state.body) continue;
			const minY = state.size.h / 2 + 2;
			if (state.body.position.y < minY) {
				Matter.Body.setPosition(state.body, {
					x: state.body.position.x,
					y: minY,
				});
			}
		}

		ceilingAdded = true;
		ceilingWall = Matter.Bodies.rectangle(
			stageWidth / 2,
			-WALL_THICKNESS / 2,
			stageWidth + WALL_THICKNESS * 2,
			WALL_THICKNESS,
			WALL_OPTIONS,
		);
		Matter.Composite.add(engine.world, ceilingWall);
	};

	const canPauseIdleLoop = (): boolean => {
		if (!hasDropped || activeDrag !== null) return false;
		if (!cardStates.every((state) => state.spawned && state.body)) return false;
		return cardStates.every((state) => Boolean(state.body?.isSleeping));
	};

	const stepFrame = (now: number) => {
		rafId = null;
		if (disposed || prefersReducedMotion || isSkipped || document.hidden || !engine) {
			return;
		}

		const delta = lastFrameTime ? Math.min(MAX_FRAME_DELTA_MS, now - lastFrameTime) : FIXED_STEP_MS;
		lastFrameTime = now;
		accumulatorMs += delta;

		let substeps = 0;
		while (accumulatorMs >= FIXED_STEP_MS && substeps < 3) {
			Matter.Engine.update(engine, FIXED_STEP_MS);
			accumulatorMs -= FIXED_STEP_MS;
			substeps += 1;
		}
		if (accumulatorMs >= FIXED_STEP_MS) {
			accumulatorMs = 0;
		}

		maybeActivateCeiling();
		renderCards();

		if (canPauseIdleLoop()) {
			lastFrameTime = 0;
			return;
		}

		rafId = requestAnimationFrame(stepFrame);
	};

	const startLoop = () => {
		if (disposed || prefersReducedMotion || isSkipped || document.hidden || !engine) {
			return;
		}
		if (rafId === null) {
			lastFrameTime = 0;
			rafId = requestAnimationFrame(stepFrame);
		}
	};

	const syncStageBounds = () => {
		const stageRect = stage.getBoundingClientRect();
		const nextWidth = stage.clientWidth || stageRect.width;
		const nextHeight = stage.clientHeight || stageRect.height;
		if (nextWidth <= 0 || nextHeight <= 0) return;

		if (
			Math.abs(nextWidth - stageWidth) >= 2 ||
			Math.abs(nextHeight - stageHeight) >= 2
		) {
			stageWidth = nextWidth;
			stageHeight = nextHeight;
			rebuildBoundaries();
		}
	};

	const spawnCard = (state: ReviewCardState) => {
		if (disposed || prefersReducedMotion || !engine || state.spawned) return;

		syncStageBounds();

		state.size = computeCardDimensions(state.aspect, stageWidth, stageHeight);
		applyCardSizeToElement(state);

		const laneIndex = LANE_ORDER[state.index % LANE_ORDER.length];
		const paddingX = Math.max(state.size.w / 2 + 16, stageWidth * 0.08);
		const usableWidth = Math.max(0, stageWidth - paddingX * 2);
		const spawnX =
			usableWidth > 0
				? paddingX + (laneIndex / (cardStates.length - 1)) * usableWidth
				: stageWidth / 2;

		const spawnY = -state.size.h / 2 - 16;

		const body = Matter.Bodies.rectangle(spawnX, spawnY, state.size.w, state.size.h, {
			...CARD_BODY_OPTIONS,
			chamfer: { radius: Math.min(CARD_CHAMFER_RADIUS, state.size.w * 0.15, state.size.h * 0.15) },
			angle: INITIAL_TILTS[state.index % INITIAL_TILTS.length],
		});

		Matter.Body.setVelocity(body, { x: 0, y: INITIAL_FALL_SPEED });
		Matter.Composite.add(engine.world, body);

		state.body = body;
		state.spawned = true;
		state.el.style.zIndex = String(++topZIndex);
		state.el.dataset.ready = 'true';
		renderCards();
		startLoop();
	};

	const triggerRain = () => {
		if (hasDropped || disposed || prefersReducedMotion) return;
		hasDropped = true;

		visibilityTriggerObserver?.disconnect();
		visibilityTriggerObserver = null;

		if (!hasInteracted) {
			setHintVisible(true);
		}

		for (let i = 0; i < cardStates.length; i += 1) {
			const delay = SPAWN_DELAYS_MS[i] ?? i * 260;
			if (delay === 0) {
				spawnCard(cardStates[i]);
			} else {
				const timerId = window.setTimeout(() => {
					spawnCard(cardStates[i]);
				}, delay);
				spawnTimers.push(timerId);
			}
		}
	};

	const toClampedStagePoint = (clientX: number, clientY: number): Matter.Vector => {
		const rect = stage.getBoundingClientRect();
		const margin = 10;
		return {
			x: clamp(clientX - rect.left, margin, Math.max(margin, stageWidth - margin)),
			y: clamp(clientY - rect.top, margin, Math.max(margin, stageHeight - margin)),
		};
	};

	const releaseActiveDrag = (pointerId?: number) => {
		if (!activeDrag || !engine) return;
		if (pointerId !== undefined && activeDrag.pointerId !== pointerId) return;

		const { card, constraint } = activeDrag;
		Matter.Composite.remove(engine.world, constraint);

		if (card.body) {
			clampVelocity(card.body, MAX_RELEASE_SPEED);
			Matter.Sleeping.set(card.body, false);
		}

		card.el.dataset.dragging = 'false';
		card.el.dataset.lastDragAt = String(Date.now());
		activeDrag = null;
		startLoop();
	};

	const promotePendingToActiveDrag = (
		pending: PendingDrag,
		clientX: number,
		clientY: number,
	) => {
		const { card, pointerId } = pending;
		if (!engine || !card.body) return;

		pendingDrag = null;
		lastTap = null;
		markInteracted();
		wakeAllBodies();
		card.el.style.zIndex = String(++topZIndex);
		card.el.dataset.dragging = 'true';

		const pointA = toClampedStagePoint(clientX, clientY);
		const dx = pointA.x - card.body.position.x;
		const dy = pointA.y - card.body.position.y;
		const cos = Math.cos(-card.body.angle);
		const sin = Math.sin(-card.body.angle);

		const pointB: Matter.Vector = {
			x: clamp(dx * cos - dy * sin, -card.size.w * 0.45, card.size.w * 0.45),
			y: clamp(dx * sin + dy * cos, -card.size.h * 0.45, card.size.h * 0.45),
		};

		const constraint = Matter.Constraint.create({
			pointA,
			bodyB: card.body,
			pointB,
			stiffness: 0.24,
			damping: 0.16,
			length: 0,
		});

		Matter.Composite.add(engine.world, constraint);
		activeDrag = {
			card,
			pointerId,
			constraint,
		};

		startLoop();
	};

	const onCardPointerDown = (state: ReviewCardState, event: PointerEvent) => {
		if (prefersReducedMotion || !engine || !state.body || !state.spawned) return;
		if (!event.isPrimary || event.button !== 0) return;

		if (activeDrag) {
			releaseActiveDrag();
		}

		pendingDrag = {
			card: state,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			threshold: event.pointerType === 'mouse' ? MOUSE_DRAG_THRESHOLD_PX : TOUCH_DRAG_THRESHOLD_PX,
		};

		try {
			state.el.setPointerCapture(event.pointerId);
		} catch {
			// Fallback gracefully if pointer capture is unavailable
		}
	};

	const onCardPointerMove = (state: ReviewCardState, event: PointerEvent) => {
		if (
			pendingDrag &&
			pendingDrag.card === state &&
			pendingDrag.pointerId === event.pointerId &&
			!activeDrag
		) {
			const moved = Math.hypot(
				event.clientX - pendingDrag.startX,
				event.clientY - pendingDrag.startY,
			);
			if (moved >= pendingDrag.threshold) {
				promotePendingToActiveDrag(pendingDrag, event.clientX, event.clientY);
			}
			return;
		}

		if (!activeDrag || activeDrag.card !== state || activeDrag.pointerId !== event.pointerId) {
			return;
		}
		if (!state.body) return;

		const nextPoint = toClampedStagePoint(event.clientX, event.clientY);
		activeDrag.constraint.pointA.x = nextPoint.x;
		activeDrag.constraint.pointA.y = nextPoint.y;
		Matter.Sleeping.set(state.body, false);
		startLoop();
	};

	const onCardPointerUp = (state: ReviewCardState, event: PointerEvent) => {
		if (activeDrag && activeDrag.card === state && activeDrag.pointerId === event.pointerId) {
			lastTap = null;
			releaseActiveDrag(event.pointerId);
			return;
		}

		if (pendingDrag && pendingDrag.card === state && pendingDrag.pointerId === event.pointerId) {
			pendingDrag = null;
			const now = Date.now();
			const isDoubleTap =
				lastTap !== null &&
				lastTap.card === state &&
				now - lastTap.time <= DOUBLE_TAP_DELAY_MS &&
				Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_MAX_DIST_PX;

			if (isDoubleTap) {
				lastTap = null;
				onOpenReview?.(state.el);
			} else {
				lastTap = {
					card: state,
					time: now,
					x: event.clientX,
					y: event.clientY,
				};
			}
		}
	};

	const onCardPointerCancel = (state: ReviewCardState, event: PointerEvent) => {
		if (pendingDrag && pendingDrag.card === state && pendingDrag.pointerId === event.pointerId) {
			pendingDrag = null;
		}
		if (activeDrag && activeDrag.card === state && activeDrag.pointerId === event.pointerId) {
			releaseActiveDrag(event.pointerId);
		}
	};

	const onCardKeyDown = (state: ReviewCardState, event: KeyboardEvent) => {
		if (prefersReducedMotion || !state.body || !state.spawned) return;

		let vx = 0;
		let vy = 0;
		let directionText = '';

		switch (event.key) {
			case 'ArrowLeft':
				vx = -8;
				vy = -4;
				directionText = 'movida a la izquierda';
				break;
			case 'ArrowRight':
				vx = 8;
				vy = -4;
				directionText = 'movida a la derecha';
				break;
			case 'ArrowUp':
				vy = -11;
				directionText = 'impulsada hacia arriba';
				break;
			case 'ArrowDown':
				vy = 6;
				directionText = 'impulsada hacia abajo';
				break;
			default:
				return;
		}

		event.preventDefault();
		markInteracted();
		wakeAllBodies();
		state.el.style.zIndex = String(++topZIndex);

		Matter.Body.setVelocity(state.body, {
			x: clamp(state.body.velocity.x + vx, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED),
			y: clamp(state.body.velocity.y + vy, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED),
		});

		announceMove(state.label, directionText);
		startLoop();
	};

	const cardListenerCleanup: Array<() => void> = [];

	const attachCardListeners = () => {
		if (cardListenerCleanup.length > 0) return;

		for (const state of cardStates) {
			const downHandler = (e: PointerEvent) => onCardPointerDown(state, e);
			const moveHandler = (e: PointerEvent) => onCardPointerMove(state, e);
			const upHandler = (e: PointerEvent) => onCardPointerUp(state, e);
			const cancelHandler = (e: PointerEvent) => onCardPointerCancel(state, e);
			const keyHandler = (e: KeyboardEvent) => onCardKeyDown(state, e);

			state.el.addEventListener('pointerdown', downHandler);
			state.el.addEventListener('pointermove', moveHandler);
			state.el.addEventListener('pointerup', upHandler);
			state.el.addEventListener('pointercancel', cancelHandler);
			state.el.addEventListener('lostpointercapture', cancelHandler);
			state.el.addEventListener('keydown', keyHandler);

			cardListenerCleanup.push(() => {
				state.el.removeEventListener('pointerdown', downHandler);
				state.el.removeEventListener('pointermove', moveHandler);
				state.el.removeEventListener('pointerup', upHandler);
				state.el.removeEventListener('pointercancel', cancelHandler);
				state.el.removeEventListener('lostpointercapture', cancelHandler);
				state.el.removeEventListener('keydown', keyHandler);
			});
		}
	};

	const detachCardListeners = () => {
		while (cardListenerCleanup.length > 0) {
			const cleanup = cardListenerCleanup.pop();
			cleanup?.();
		}
	};

	const evaluateVisibilityEntry = (entry: IntersectionObserverEntry): boolean => {
		if (!entry.isIntersecting) return false;
		const sectionHeight = entry.boundingClientRect.height || section.offsetHeight || 1;
		const viewportHeight = window.innerHeight || 1;

		if (sectionHeight <= viewportHeight + 16) {
			const fitsInsideViewport =
				entry.boundingClientRect.top >= -16 &&
				entry.boundingClientRect.bottom <= viewportHeight + 16;
			return fitsInsideViewport || entry.intersectionRatio >= 0.94;
		}

		// When section exceeds viewport height (e.g. stacked mobile view), fire once it fills viewport
		const requiredRatio = clamp((viewportHeight / sectionHeight) * 0.9, 0.52, 0.94);
		return entry.intersectionRatio >= requiredRatio;
	};

	const teardownPhysics = () => {
		stopLoop();
		clearSpawnTimers();
		visibilityTriggerObserver?.disconnect();
		visibilityTriggerObserver = null;
		detachCardListeners();
		activeDrag = null;
		pendingDrag = null;
		lastTap = null;

		if (engine) {
			Matter.World.clear(engine.world, false);
			Matter.Engine.clear(engine);
			engine = null;
		}

		staticWalls = [];
		ceilingWall = null;
		physicsInitialized = false;
		hasDropped = false;
		ceilingAdded = false;

		field.removeAttribute('data-physics-active');
		setHintVisible(false);

		for (const state of cardStates) {
			state.body = null;
			state.spawned = false;
			state.enteredStage = false;
			state.el.removeAttribute('data-ready');
			state.el.removeAttribute('data-dragging');
			state.el.removeAttribute('data-last-drag-at');
			state.el.removeAttribute('aria-roledescription');
			state.el.setAttribute(
				'aria-label',
				`${state.label}. Pulsa Enter o haz doble clic para ampliar.`,
			);
			state.el.style.width = '';
			state.el.style.height = '';
			state.el.style.transform = '';
			state.el.style.zIndex = '';
		}
	};

	const setupPhysics = () => {
		if (disposed || prefersReducedMotion || physicsInitialized) return;
		physicsInitialized = true;

		stageWidth = stage.clientWidth || 360;
		stageHeight = stage.clientHeight || 420;

		engine = Matter.Engine.create({
			enableSleeping: true,
			gravity: { x: 0, y: 1.15 },
		});

		field.dataset.physicsActive = 'true';
		setHintVisible(false);

		for (const state of cardStates) {
			state.size = computeCardDimensions(state.aspect, stageWidth, stageHeight);
			applyCardSizeToElement(state);
			state.el.dataset.ready = 'false';
			state.el.dataset.dragging = 'false';
			state.el.tabIndex = 0;
			state.el.setAttribute('aria-roledescription', 'tarjeta de reseña arrastrable');
			state.el.setAttribute(
				'aria-label',
				`${state.label}. Usa las flechas para mover o Enter para ampliar.`,
			);
		}

		rebuildBoundaries();
		attachCardListeners();

		visibilityTriggerObserver = new IntersectionObserver(
			(entries) => {
				if (hasDropped) return;
				for (const entry of entries) {
					if (evaluateVisibilityEntry(entry)) {
						triggerRain();
						break;
					}
				}
			},
			{ threshold: [0, 0.5, 0.65, 0.75, 0.85, 0.9, 0.95, 0.99, 1] },
		);

		visibilityTriggerObserver.observe(section);
	};

	const resizeObserver = new ResizeObserver(() => {
		if (disposed || prefersReducedMotion || !physicsInitialized || !engine) return;

		const nextWidth = stage.clientWidth;
		const nextHeight = stage.clientHeight;
		if (nextWidth <= 0 || nextHeight <= 0) return;

		if (
			Math.abs(nextWidth - stageWidth) < 2 &&
			Math.abs(nextHeight - stageHeight) < 2
		) {
			return;
		}

		const prevWidth = Math.max(1, stageWidth);
		stageWidth = nextWidth;
		stageHeight = nextHeight;

		for (const state of cardStates) {
			const prevSize = state.size;
			const nextSize = computeCardDimensions(state.aspect, stageWidth, stageHeight);
			state.size = nextSize;
			applyCardSizeToElement(state);

			if (state.body && prevSize.w > 0) {
				const scaleFactor = nextSize.w / prevSize.w;
				if (Math.abs(scaleFactor - 1) > 0.01) {
					Matter.Body.scale(state.body, scaleFactor, scaleFactor);
				}

				const halfW = nextSize.w / 2;
				const halfH = nextSize.h / 2;
				const scaledX = (state.body.position.x / prevWidth) * stageWidth;
				const clampedX = clamp(scaledX, halfW + 4, Math.max(halfW + 4, stageWidth - halfW - 4));
				const clampedY = state.enteredStage
					? clamp(
							state.body.position.y,
							halfH + 4,
							Math.max(halfH + 4, stageHeight - halfH - 4),
						)
					: Math.min(state.body.position.y, stageHeight - halfH - 4);

				Matter.Body.setPosition(state.body, { x: clampedX, y: clampedY });
			}
		}

		rebuildBoundaries();
		wakeAllBodies();
		renderCards();
		startLoop();
	});

	const onVisibilityChange = () => {
		if (document.hidden) {
			releaseActiveDrag();
			stopLoop();
		} else if (hasDropped && !isSkipped && !prefersReducedMotion) {
			wakeAllBodies();
			startLoop();
		}
	};

	const onContentVisibilityChange = (event: Event) => {
		const cvEvent = event as ContentVisibilityEvent;
		isSkipped = Boolean(cvEvent.skipped);
		if (isSkipped) {
			releaseActiveDrag();
			stopLoop();
		} else if (hasDropped && !document.hidden && !prefersReducedMotion) {
			startLoop();
		}
	};

	const onReducedMotionChange = (event: MediaQueryListEvent) => {
		prefersReducedMotion = event.matches;
		if (prefersReducedMotion) {
			teardownPhysics();
		} else {
			setupPhysics();
		}
	};

	if (!prefersReducedMotion) {
		setupPhysics();
	}

	resizeObserver.observe(stage);
	document.addEventListener('visibilitychange', onVisibilityChange);
	reducedMotionQuery.addEventListener('change', onReducedMotionChange);

	const supportsContentVisibility = 'contentVisibility' in document.documentElement.style;
	if (supportsContentVisibility) {
		section.addEventListener('contentvisibilityautostatechange', onContentVisibilityChange);
	} else {
		fallbackVisibilityObserver = new IntersectionObserver(
			(entries) => {
				const visible = entries.some((entry) => entry.isIntersecting);
				isSkipped = !visible;
				if (isSkipped) {
					releaseActiveDrag();
					stopLoop();
				} else if (hasDropped && !document.hidden && !prefersReducedMotion) {
					startLoop();
				}
			},
			{ rootMargin: '200px 0px' },
		);
		fallbackVisibilityObserver.observe(section);
	}

	return () => {
		disposed = true;
		if (liveClearTimer !== null) {
			window.clearTimeout(liveClearTimer);
			liveClearTimer = null;
		}
		resizeObserver.disconnect();
		fallbackVisibilityObserver?.disconnect();
		section.removeEventListener('contentvisibilityautostatechange', onContentVisibilityChange);
		document.removeEventListener('visibilitychange', onVisibilityChange);
		reducedMotionQuery.removeEventListener('change', onReducedMotionChange);
		teardownPhysics();
	};
}
