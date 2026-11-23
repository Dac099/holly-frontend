export interface ResellersFireworksController {
	trigger: () => void;
	resize: () => void;
	stop: () => void;
	isActive: () => boolean;
	destroy: () => void;
}

type BurstType = 'peony' | 'ring' | 'willow';

interface PaletteSwatch {
	primary: string;
	core: string;
	glow: string;
}

interface TrailPoint {
	x: number;
	y: number;
}

interface SparkParticle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	drag: number;
	gravity: number;
	age: number;
	life: number;
	size: number;
	swatch: PaletteSwatch;
	shimmer: boolean;
	shimmerPhase: number;
	trail: TrailPoint[];
	maxTrail: number;
}

interface CometRocket {
	x: number;
	y: number;
	vx: number;
	vy: number;
	gravity: number;
	age: number;
	duration: number;
	burstType: BurstType;
	swatch: PaletteSwatch;
	scale: number;
	trail: TrailPoint[];
}

interface BurstHalo {
	x: number;
	y: number;
	age: number;
	duration: number;
	maxRadius: number;
	swatch: PaletteSwatch;
}

interface ScheduledWave {
	delayMs: number;
	fired: boolean;
	mode: 'burst' | 'rocket';
	xNorm: number;
	yNorm: number;
	burstType: BurstType;
	swatchIndex: number;
	scale: number;
}

const SHOW_DURATION_MS = 3000;
const FADE_OUT_WINDOW_MS = 450;
const MAX_PARTICLES = 520;
const MAX_FRAME_DELTA_S = 0.05;
const ROCKET_GRAVITY = 220;

const PALETTE: readonly PaletteSwatch[] = [
	{ primary: '#FFD84D', core: '#FFF6D6', glow: 'rgba(255, 216, 77, 0.38)' },
	{ primary: '#F1E5BC', core: '#FFFFFF', glow: 'rgba(241, 229, 188, 0.36)' },
	{ primary: '#FF9233', core: '#FFE08A', glow: 'rgba(255, 146, 51, 0.36)' },
	{ primary: '#FF6B9D', core: '#FFE4EE', glow: 'rgba(255, 107, 157, 0.36)' },
	{ primary: '#63E6E2', core: '#E0FFFD', glow: 'rgba(99, 230, 226, 0.36)' },
	{ primary: '#B8F25A', core: '#F1FFD6', glow: 'rgba(184, 242, 90, 0.36)' },
];

const WAVE_TEMPLATES: ReadonlyArray<Omit<ScheduledWave, 'fired'>> = [
	{ delayMs: 140, mode: 'rocket', xNorm: 0.78, yNorm: 0.32, burstType: 'ring', swatchIndex: 4, scale: 1.0 },
	{ delayMs: 280, mode: 'burst', xNorm: 0.22, yNorm: 0.24, burstType: 'willow', swatchIndex: 0, scale: 1.05 },
	{ delayMs: 420, mode: 'rocket', xNorm: 0.52, yNorm: 0.20, burstType: 'peony', swatchIndex: 1, scale: 1.12 },
	{ delayMs: 620, mode: 'burst', xNorm: 0.86, yNorm: 0.46, burstType: 'peony', swatchIndex: 2, scale: 0.95 },
	{ delayMs: 780, mode: 'rocket', xNorm: 0.16, yNorm: 0.44, burstType: 'ring', swatchIndex: 5, scale: 0.96 },
	{ delayMs: 960, mode: 'burst', xNorm: 0.64, yNorm: 0.26, burstType: 'willow', swatchIndex: 0, scale: 1.1 },
	{ delayMs: 1140, mode: 'rocket', xNorm: 0.36, yNorm: 0.34, burstType: 'peony', swatchIndex: 3, scale: 1.04 },
	{ delayMs: 1340, mode: 'burst', xNorm: 0.74, yNorm: 0.62, burstType: 'ring', swatchIndex: 4, scale: 0.92 },
	{ delayMs: 1520, mode: 'rocket', xNorm: 0.24, yNorm: 0.58, burstType: 'willow', swatchIndex: 1, scale: 1.0 },
	{ delayMs: 1700, mode: 'burst', xNorm: 0.50, yNorm: 0.40, burstType: 'peony', swatchIndex: 2, scale: 1.16 },
	{ delayMs: 1880, mode: 'burst', xNorm: 0.84, yNorm: 0.22, burstType: 'ring', swatchIndex: 5, scale: 0.94 },
	{ delayMs: 2020, mode: 'burst', xNorm: 0.14, yNorm: 0.20, burstType: 'peony', swatchIndex: 0, scale: 1.02 },
];

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

export function createResellersFireworks(
	canvas: HTMLCanvasElement,
	container: HTMLElement,
): ResellersFireworksController {
	const ctx = canvas.getContext('2d');
	const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

	let disposed = false;
	let active = false;
	let rafId: number | null = null;

	let width = 0;
	let height = 0;
	let dpr = 1;
	let showStartTime = 0;
	let lastFrameTime = 0;

	let particles: SparkParticle[] = [];
	let rockets: CometRocket[] = [];
	let halos: BurstHalo[] = [];
	let schedule: ScheduledWave[] = [];

	const syncSize = (): boolean => {
		const rect = container.getBoundingClientRect();
		const nextWidth = Math.round(container.clientWidth || rect.width);
		const nextHeight = Math.round(container.clientHeight || rect.height);
		if (nextWidth <= 0 || nextHeight <= 0) return false;

		const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
		const pixelWidth = Math.round(nextWidth * nextDpr);
		const pixelHeight = Math.round(nextHeight * nextDpr);

		width = nextWidth;
		height = nextHeight;
		dpr = nextDpr;

		if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
			canvas.width = pixelWidth;
			canvas.height = pixelHeight;
		}
		if (ctx) {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		return true;
	};

	const clearCanvas = () => {
		if (!ctx || width <= 0 || height <= 0) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
	};

	const cancelFrame = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		lastFrameTime = 0;
	};

	const spawnBurst = (
		x: number,
		y: number,
		burstType: BurstType,
		swatch: PaletteSwatch,
		scale = 1,
	) => {
		const availableSlots = MAX_PARTICLES - particles.length;
		if (availableSlots <= 0) return;

		const baseRadius = Math.min(width, height) * 0.24 * scale;
		halos.push({
			x,
			y,
			age: 0,
			duration: 0.28,
			maxRadius: clamp(baseRadius * 0.65, 42, 125),
			swatch,
		});

		const secondarySwatch = PALETTE[(PALETTE.indexOf(swatch) + 1) % PALETTE.length];

		if (burstType === 'ring') {
			const ringCount = Math.min(availableSlots, 34);
			const tilt = randomBetween(0.68, 0.96);
			const rotation = randomBetween(-0.35, 0.35);
			const cosR = Math.cos(rotation);
			const sinR = Math.sin(rotation);
			const ringSpeed = clamp(baseRadius * 1.45, 130, 270);

			for (let i = 0; i < ringCount; i += 1) {
				const theta = (i / ringCount) * Math.PI * 2 + randomBetween(-0.04, 0.04);
				const speedJitter = randomBetween(0.92, 1.08);
				const rawVx = Math.cos(theta) * ringSpeed * speedJitter;
				const rawVy = Math.sin(theta) * ringSpeed * tilt * speedJitter;
				const vx = rawVx * cosR - rawVy * sinR;
				const vy = rawVx * sinR + rawVy * cosR;

				particles.push({
					x,
					y,
					vx,
					vy,
					drag: 1.9,
					gravity: 115,
					age: 0,
					life: randomBetween(0.75, 1.05),
					size: randomBetween(2.2, 3.2),
					swatch: i % 5 === 0 ? secondarySwatch : swatch,
					shimmer: false,
					shimmerPhase: 0,
					trail: [{ x, y }],
					maxTrail: 6,
				});
			}

			const coreCount = Math.min(MAX_PARTICLES - particles.length, 10);
			for (let i = 0; i < coreCount; i += 1) {
				const theta = randomBetween(0, Math.PI * 2);
				const speed = randomBetween(35, ringSpeed * 0.45);
				particles.push({
					x,
					y,
					vx: Math.cos(theta) * speed,
					vy: Math.sin(theta) * speed,
					drag: 2.2,
					gravity: 120,
					age: 0,
					life: randomBetween(0.55, 0.8),
					size: randomBetween(1.8, 2.6),
					swatch: secondarySwatch,
					shimmer: false,
					shimmerPhase: 0,
					trail: [{ x, y }],
					maxTrail: 4,
				});
			}
			return;
		}

		if (burstType === 'willow') {
			const count = Math.min(availableSlots, 44);
			const maxSpeed = clamp(baseRadius * 1.38, 120, 250);
			for (let i = 0; i < count; i += 1) {
				const theta = (i / count) * Math.PI * 2 + randomBetween(-0.08, 0.08);
				const speed = maxSpeed * randomBetween(0.45, 1.05);
				particles.push({
					x,
					y,
					vx: Math.cos(theta) * speed,
					vy: Math.sin(theta) * speed - 22,
					drag: 2.5,
					gravity: 210,
					age: 0,
					life: randomBetween(1.05, 1.45),
					size: randomBetween(2.2, 3.1),
					swatch: i % 4 === 0 ? PALETTE[1] : swatch,
					shimmer: true,
					shimmerPhase: randomBetween(0, Math.PI * 2),
					trail: [{ x, y }],
					maxTrail: 8,
				});
			}
			return;
		}

		// Peony burst
		const count = Math.min(availableSlots, 46);
		const maxSpeed = clamp(baseRadius * 1.55, 135, 290);
		for (let i = 0; i < count; i += 1) {
			const theta = (i / count) * Math.PI * 2 + randomBetween(-0.1, 0.1);
			const speed = maxSpeed * randomBetween(0.38, 1.06);
			particles.push({
				x,
				y,
				vx: Math.cos(theta) * speed,
				vy: Math.sin(theta) * speed,
				drag: 1.85,
				gravity: 135,
				age: 0,
				life: randomBetween(0.72, 1.12),
				size: randomBetween(2.1, 3.3),
				swatch: i % 3 === 0 ? secondarySwatch : swatch,
				shimmer: false,
				shimmerPhase: 0,
				trail: [{ x, y }],
				maxTrail: 6,
			});
		}
	};

	const launchRocket = (
		targetX: number,
		targetY: number,
		burstType: BurstType,
		swatch: PaletteSwatch,
		scale = 1,
	) => {
		const startX = clamp(targetX + randomBetween(-width * 0.08, width * 0.08), width * 0.08, width * 0.92);
		const startY = height * randomBetween(0.91, 0.97);
		const duration = randomBetween(0.32, 0.46);
		const vx = (targetX - startX) / duration;
		const vy = (targetY - startY - 0.5 * ROCKET_GRAVITY * duration * duration) / duration;

		rockets.push({
			x: startX,
			y: startY,
			vx,
			vy,
			gravity: ROCKET_GRAVITY,
			age: 0,
			duration,
			burstType,
			swatch,
			scale,
			trail: [{ x: startX, y: startY }],
		});
	};

	const spawnWave = (wave: Omit<ScheduledWave, 'fired'>) => {
		const jitterX = randomBetween(-0.04, 0.04);
		const jitterY = randomBetween(-0.04, 0.04);
		const targetX = clamp(width * (wave.xNorm + jitterX), width * 0.1, width * 0.9);
		const targetY = clamp(height * (wave.yNorm + jitterY), height * 0.14, height * 0.76);
		const swatch = PALETTE[wave.swatchIndex % PALETTE.length];

		if (wave.mode === 'rocket') {
			launchRocket(targetX, targetY, wave.burstType, swatch, wave.scale);
		} else {
			spawnBurst(targetX, targetY, wave.burstType, swatch, wave.scale);
		}
	};

	const queueWaves = () => {
		const offset = Math.floor(Math.random() * PALETTE.length);
		schedule = WAVE_TEMPLATES.map((template, index) => ({
			...template,
			swatchIndex: (template.swatchIndex + offset + (index % 2)) % PALETTE.length,
			fired: false,
		}));
	};

	const fireOpeningVolley = () => {
		const baseOffset = Math.floor(Math.random() * PALETTE.length);
		spawnBurst(
			width * randomBetween(0.24, 0.34),
			height * randomBetween(0.24, 0.34),
			'peony',
			PALETTE[baseOffset % PALETTE.length],
			1.08,
		);
		spawnBurst(
			width * randomBetween(0.68, 0.78),
			height * randomBetween(0.20, 0.30),
			'ring',
			PALETTE[(baseOffset + 1) % PALETTE.length],
			1.02,
		);
		launchRocket(
			width * randomBetween(0.46, 0.56),
			height * randomBetween(0.18, 0.28),
			'willow',
			PALETTE[(baseOffset + 2) % PALETTE.length],
			1.12,
		);
	};

	const drawTrail = (
		trail: TrailPoint[],
		headX: number,
		headY: number,
		strokeStyle: string,
		lineWidth: number,
		alpha: number,
	) => {
		if (!ctx || trail.length === 0 || alpha <= 0.01) return;

		ctx.lineCap = 'round';
		for (let i = 0; i < trail.length; i += 1) {
			const p0 = trail[i];
			const p1 = i + 1 < trail.length ? trail[i + 1] : { x: headX, y: headY };
			const segmentProgress = (i + 1) / trail.length;
			ctx.globalAlpha = alpha * segmentProgress * 0.78;
			ctx.strokeStyle = strokeStyle;
			ctx.lineWidth = Math.max(0.8, lineWidth * segmentProgress);
			ctx.beginPath();
			ctx.moveTo(p0.x, p0.y);
			ctx.lineTo(p1.x, p1.y);
			ctx.stroke();
		}
	};

	const stepFrame = (now: number) => {
		rafId = null;
		if (disposed || !active || !ctx) return;

		if (showStartTime === 0) {
			showStartTime = now;
		}
		const elapsedMs = now - showStartTime;
		if (elapsedMs >= SHOW_DURATION_MS) {
			stop();
			return;
		}

		const dt = lastFrameTime
			? Math.min(MAX_FRAME_DELTA_S, Math.max(0.001, (now - lastFrameTime) / 1000))
			: 1 / 60;
		lastFrameTime = now;

		const remainingMs = SHOW_DURATION_MS - elapsedMs;
		const globalFade =
			remainingMs < FADE_OUT_WINDOW_MS
				? clamp(remainingMs / FADE_OUT_WINDOW_MS, 0, 1)
				: 1;

		if (remainingMs > FADE_OUT_WINDOW_MS) {
			for (const wave of schedule) {
				if (!wave.fired && elapsedMs >= wave.delayMs) {
					wave.fired = true;
					spawnWave(wave);
				}
			}
		}

		clearCanvas();

		ctx.save();
		ctx.globalCompositeOperation = 'lighter';
		ctx.lineCap = 'round';

		// Update & draw soft expanding burst halos
		for (let i = halos.length - 1; i >= 0; i -= 1) {
			const halo = halos[i];
			halo.age += dt;
			if (halo.age >= halo.duration) {
				halos.splice(i, 1);
				continue;
			}
			const progress = halo.age / halo.duration;
			const radius = 8 + (halo.maxRadius - 8) * (1 - (1 - progress) * (1 - progress));
			const haloAlpha = (1 - progress) * 0.42 * globalFade;
			if (haloAlpha <= 0.01) continue;

			const gradient = ctx.createRadialGradient(halo.x, halo.y, 0, halo.x, halo.y, radius);
			gradient.addColorStop(0, halo.swatch.glow);
			gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
			ctx.globalAlpha = haloAlpha;
			ctx.fillStyle = gradient;
			ctx.beginPath();
			ctx.arc(halo.x, halo.y, radius, 0, Math.PI * 2);
			ctx.fill();
		}

		// Update & draw rising comet rockets
		for (let i = rockets.length - 1; i >= 0; i -= 1) {
			const rocket = rockets[i];
			rocket.trail.push({ x: rocket.x, y: rocket.y });
			if (rocket.trail.length > 7) {
				rocket.trail.shift();
			}

			rocket.age += dt;
			rocket.vy += rocket.gravity * dt;
			rocket.x += rocket.vx * dt;
			rocket.y += rocket.vy * dt;

			if (rocket.age >= rocket.duration) {
				rockets.splice(i, 1);
				if (remainingMs > FADE_OUT_WINDOW_MS * 0.5) {
					spawnBurst(rocket.x, rocket.y, rocket.burstType, rocket.swatch, rocket.scale);
				}
				continue;
			}

			drawTrail(rocket.trail, rocket.x, rocket.y, rocket.swatch.primary, 2.8, globalFade);
			ctx.globalAlpha = globalFade;
			ctx.fillStyle = rocket.swatch.core;
			ctx.beginPath();
			ctx.arc(rocket.x, rocket.y, 2.6, 0, Math.PI * 2);
			ctx.fill();
		}

		// Update & draw burst sparks
		for (let i = particles.length - 1; i >= 0; i -= 1) {
			const p = particles[i];
			p.age += dt;
			if (p.age >= p.life) {
				particles.splice(i, 1);
				continue;
			}

			p.trail.push({ x: p.x, y: p.y });
			if (p.trail.length > p.maxTrail) {
				p.trail.shift();
			}

			const dragFactor = Math.exp(-p.drag * dt);
			p.vx *= dragFactor;
			p.vy = p.vy * dragFactor + p.gravity * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;

			const lifeProgress = p.age / p.life;
			let alpha = (1 - lifeProgress * lifeProgress) * globalFade;
			if (p.shimmer && lifeProgress > 0.3) {
				// Gentle low-frequency shimmer (< 2 Hz) strictly below WCAG 3 Hz flash threshold
				alpha *= 0.8 + 0.2 * Math.sin(p.age * 9.5 + p.shimmerPhase);
			}
			if (alpha <= 0.01) continue;

			drawTrail(p.trail, p.x, p.y, p.swatch.primary, p.size * 0.85, alpha);

			ctx.globalAlpha = alpha * 0.32;
			ctx.fillStyle = p.swatch.primary;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.size * 2.1, 0, Math.PI * 2);
			ctx.fill();

			ctx.globalAlpha = alpha;
			ctx.fillStyle = lifeProgress < 0.35 ? p.swatch.core : p.swatch.primary;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.size * (1 - lifeProgress * 0.35), 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.restore();

		rafId = requestAnimationFrame(stepFrame);
	};

	const stop = () => {
		cancelFrame();
		active = false;
		showStartTime = 0;
		particles = [];
		rockets = [];
		halos = [];
		schedule = [];
		canvas.dataset.active = 'false';
		clearCanvas();
	};

	const trigger = () => {
		if (disposed || !ctx || reducedMotionQuery.matches) return;
		if (!syncSize()) return;

		active = true;
		showStartTime = 0;
		canvas.dataset.active = 'true';
		queueWaves();
		fireOpeningVolley();

		if (rafId === null) {
			lastFrameTime = 0;
			rafId = requestAnimationFrame(stepFrame);
		}
	};

	const resize = () => {
		if (disposed || !active) return;
		syncSize();
	};

	const isActive = (): boolean => active;

	const destroy = () => {
		stop();
		disposed = true;
	};

	return {
		trigger,
		resize,
		stop,
		isActive,
		destroy,
	};
}
