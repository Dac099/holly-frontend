import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_URL = '/models/caja-salsas.glb';
const BACKGROUND_HEX = 0xf1e5bc;
const SHADOW_HEX = 0x3b2614;
const CAMERA_FOV = 34;
const LERP_SPEED = 8;

const BOX_COMPLETE_AT = 0.88;
const STORY_START = 0.02;
const STORY_END = 0.88;
const CTA_START = 0.89;

interface PackageViewerElements {
	section: HTMLElement;
	viewerFrame: HTMLElement;
	canvas: HTMLCanvasElement;
	scrollHint: HTMLElement | null;
	ctaWrap: HTMLElement | null;
	storyItems: HTMLElement[];
}

interface ContentVisibilityEvent extends Event {
	skipped: boolean;
}

function hasWebGLSupport(): boolean {
	return typeof window !== 'undefined' && Boolean(window.WebGLRenderingContext);
}

export function initPackageViewer({
	section,
	viewerFrame,
	canvas,
	scrollHint,
	ctaWrap,
	storyItems,
}: PackageViewerElements): () => void {
	const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	let prefersReducedMotion = reducedMotionQuery.matches;

	let initialized = false;
	let disposed = false;
	let isSkipped = false;
	let hasWebGL = false;
	let rafId: number | null = null;
	let lastFrameTime = 0;

	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let pmremGenerator: THREE.PMREMGenerator | null = null;
	let envRenderTarget: THREE.WebGLRenderTarget | null = null;
	let mixer: THREE.AnimationMixer | null = null;
	let action: THREE.AnimationAction | null = null;
	let clipDuration = 0;

	let modelSize = new THREE.Vector3(0.36, 0.3, 0.3);
	let targetCenter = new THREE.Vector3(0, 0.12, 0);

	let targetProgress = prefersReducedMotion ? 1 : 0;
	let currentProgress = targetProgress;

	const setDatasetIfChanged = (el: HTMLElement | null, key: string, value: string) => {
		if (el && el.dataset[key] !== value) {
			el.dataset[key] = value;
		}
	};

	const syncOverlayUI = (progress: number) => {
		const boxProgress = prefersReducedMotion
			? 1
			: Math.min(1, Math.max(0, progress / BOX_COMPLETE_AT));

		const hintVisible = !prefersReducedMotion && boxProgress < 0.985;
		setDatasetIfChanged(scrollHint, 'visible', hintVisible ? 'true' : 'false');

		const ctaVisible = prefersReducedMotion || progress >= CTA_START;
		setDatasetIfChanged(ctaWrap, 'visible', ctaVisible ? 'true' : 'false');

		if (storyItems.length === 0) return;

		if (prefersReducedMotion || progress >= STORY_END) {
			for (const item of storyItems) {
				setDatasetIfChanged(item, 'state', 'after');
			}
			return;
		}

		if (progress < STORY_START) {
			for (const item of storyItems) {
				setDatasetIfChanged(item, 'state', 'before');
			}
			return;
		}

		const storyFraction = (progress - STORY_START) / (STORY_END - STORY_START);
		const activeIndex = Math.min(
			storyItems.length - 1,
			Math.floor(storyFraction * storyItems.length),
		);

		for (let i = 0; i < storyItems.length; i += 1) {
			const nextState =
				i < activeIndex ? 'after' : i === activeIndex ? 'active' : 'before';
			setDatasetIfChanged(storyItems[i], 'state', nextState);
		}
	};

	const showFallback = () => {
		hasWebGL = false;
		viewerFrame.dataset.fallback = 'true';
		canvas.dataset.ready = 'false';
		syncOverlayUI(computeScrollProgress());
	};

	const computeScrollProgress = (): number => {
		if (prefersReducedMotion) return 1;

		const rect = section.getBoundingClientRect();
		const viewportHeight = window.innerHeight || 1;
		const travel = Math.max(1, rect.height - viewportHeight);
		const raw = -rect.top / travel;
		return Math.min(1, Math.max(0, raw));
	};

	const applyAnimationProgress = (progress: number) => {
		syncOverlayUI(progress);
		if (!mixer || !action || clipDuration <= 0) return;
		const boxProgress = prefersReducedMotion
			? 1
			: Math.min(1, Math.max(0, progress / BOX_COMPLETE_AT));
		const clamped = Math.min(0.9995, Math.max(0, boxProgress));
		mixer.setTime(clamped * clipDuration);
	};

	const updateCameraFraming = () => {
		if (!camera) return;

		const width = viewerFrame.clientWidth || window.innerWidth;
		const height = viewerFrame.clientHeight || window.innerHeight;
		const aspect = Math.max(0.4, width / Math.max(1, height));
		const isMobile = width < 720;

		camera.aspect = aspect;
		camera.updateProjectionMatrix();

		if (renderer) {
			renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
			renderer.setSize(width, height, false);
		}

		// Keep clear margins for top header/hint, desktop side callouts, and bottom mobile text/CTA
		const vFovRad = THREE.MathUtils.degToRad(camera.fov);
		const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);

		const verticalOccupancy = isMobile ? 0.42 : 0.48;
		const horizontalOccupancy = isMobile ? 0.78 : width >= 1024 ? 0.44 : 0.46;

		const fitHeightDist =
			(modelSize.y * 0.5) / (Math.tan(vFovRad / 2) * verticalOccupancy);
		const fitWidthDist =
			(Math.max(modelSize.x, modelSize.z) * 0.5) /
			(Math.tan(hFovRad / 2) * horizontalOccupancy);
		const distance = Math.max(fitHeightDist, fitWidthDist) + modelSize.z * 0.35;

		// Fixed elevated 3/4 front view: shows closed box cleanly and reveals bottles + inner lid as it opens
		const azimuth = THREE.MathUtils.degToRad(16);
		const elevation = THREE.MathUtils.degToRad(26);
		const horiz = distance * Math.cos(elevation);

		camera.position.set(
			targetCenter.x + horiz * Math.sin(azimuth),
			targetCenter.y + distance * Math.sin(elevation),
			targetCenter.z + horiz * Math.cos(azimuth),
		);
		camera.lookAt(targetCenter);
	};

	const stopLoop = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	};

	const renderFrame = (now: number) => {
		rafId = null;
		if (disposed || isSkipped || document.hidden || !renderer || !scene || !camera) {
			return;
		}

		const delta = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 1 / 60;
		lastFrameTime = now;

		let needsNextFrame = false;

		if (prefersReducedMotion) {
			if (currentProgress !== 1) {
				currentProgress = 1;
				applyAnimationProgress(1);
			}
		} else {
			const diff = targetProgress - currentProgress;
			if (Math.abs(diff) > 0.00035) {
				const factor = 1 - Math.exp(-LERP_SPEED * delta);
				currentProgress += diff * factor;
				applyAnimationProgress(currentProgress);
				needsNextFrame = true;
			} else if (currentProgress !== targetProgress) {
				currentProgress = targetProgress;
				applyAnimationProgress(currentProgress);
			}
		}

		renderer.render(scene, camera);

		if (needsNextFrame) {
			rafId = requestAnimationFrame(renderFrame);
		} else {
			lastFrameTime = 0;
		}
	};

	const requestRender = () => {
		if (disposed || isSkipped || document.hidden || !renderer) return;
		if (rafId === null) {
			lastFrameTime = 0;
			rafId = requestAnimationFrame(renderFrame);
		}
	};

	const onScroll = () => {
		targetProgress = computeScrollProgress();
		if (!hasWebGL) {
			currentProgress = targetProgress;
			syncOverlayUI(currentProgress);
			return;
		}
		requestRender();
	};

	const onVisibilityChange = () => {
		if (document.hidden) {
			stopLoop();
		} else {
			targetProgress = computeScrollProgress();
			if (!hasWebGL) {
				syncOverlayUI(targetProgress);
			} else {
				requestRender();
			}
		}
	};

	const onReducedMotionChange = (event: MediaQueryListEvent) => {
		prefersReducedMotion = event.matches;
		targetProgress = computeScrollProgress();
		if (prefersReducedMotion) {
			currentProgress = 1;
			applyAnimationProgress(1);
		} else {
			syncOverlayUI(currentProgress);
		}
		requestRender();
	};

	const resizeObserver = new ResizeObserver(() => {
		if (!initialized || disposed || !hasWebGL) return;
		updateCameraFraming();
		requestRender();
	});

	const setupScene = () => {
		if (initialized || disposed) return;
		initialized = true;

		window.addEventListener('scroll', onScroll, { passive: true });
		document.addEventListener('visibilitychange', onVisibilityChange);
		syncOverlayUI(computeScrollProgress());

		if (!hasWebGLSupport()) {
			showFallback();
			return;
		}

		try {
			renderer = new THREE.WebGLRenderer({
				canvas,
				antialias: true,
				alpha: true,
				powerPreference: 'high-performance',
			});
			hasWebGL = true;
		} catch {
			showFallback();
			return;
		}

		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.08;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFShadowMap;
		// RGB matches --color-primary (#F1E5BC) with 0 alpha so PET transmission refracts warm cream seamlessly
		renderer.setClearColor(BACKGROUND_HEX, 0);

		scene = new THREE.Scene();

		// Studio reflections for PET clearcoat, specular, and transmission materials
		pmremGenerator = new THREE.PMREMGenerator(renderer);
		const roomEnvironment = new RoomEnvironment();
		envRenderTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
		scene.environment = envRenderTarget.texture;
		scene.environmentIntensity = 0.85;
		roomEnvironment.dispose();

		const width = viewerFrame.clientWidth || window.innerWidth;
		const height = viewerFrame.clientHeight || window.innerHeight;
		camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / Math.max(1, height), 0.02, 20);

		// Warm studio three-point lighting
		const hemiLight = new THREE.HemisphereLight(0xfff9ec, 0xd8c79b, 0.75);
		scene.add(hemiLight);

		const keyLight = new THREE.DirectionalLight(0xfff5e4, 1.85);
		keyLight.position.set(1.6, 3.1, 2.2);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.set(1024, 1024);
		keyLight.shadow.camera.near = 0.5;
		keyLight.shadow.camera.far = 9;
		keyLight.shadow.camera.left = -0.55;
		keyLight.shadow.camera.right = 0.55;
		keyLight.shadow.camera.top = 0.55;
		keyLight.shadow.camera.bottom = -0.55;
		keyLight.shadow.bias = -0.0004;
		keyLight.shadow.normalBias = 0.012;
		keyLight.shadow.radius = 4;
		scene.add(keyLight);

		const fillLight = new THREE.DirectionalLight(0xffeed4, 0.6);
		fillLight.position.set(-1.9, 1.6, 1.1);
		scene.add(fillLight);

		const rimLight = new THREE.DirectionalLight(0xfff2da, 0.45);
		rimLight.position.set(-0.4, 2.0, -2.0);
		scene.add(rimLight);

		const loader = new GLTFLoader();
		loader.load(
			MODEL_URL,
			(gltf) => {
				if (disposed || !scene) return;

				const model = gltf.scene;
				model.traverse((obj) => {
					if (!(obj instanceof THREE.Mesh)) return;
					const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
					const isTransmissive = materials.some(
						(mat) =>
							mat instanceof THREE.MeshPhysicalMaterial &&
							(mat.transmission > 0.1 || mat.transparent),
					);
					obj.castShadow = !isTransmissive;
					obj.receiveShadow = true;
				});

				scene.add(model);

				const boxClosed = new THREE.Box3().setFromObject(model);
				const boxUnion = boxClosed.clone();

				if (gltf.animations.length > 0) {
					mixer = new THREE.AnimationMixer(model);
					const clip = gltf.animations[0];
					clipDuration = clip.duration;
					action = mixer.clipAction(clip);
					action.setLoop(THREE.LoopOnce, 1);
					action.clampWhenFinished = true;
					action.play();

					// Sample mid and end frames to compute full framing envelope
					mixer.setTime(clipDuration * 0.5);
					model.updateMatrixWorld(true);
					boxUnion.union(new THREE.Box3().setFromObject(model));

					mixer.setTime(clipDuration * 0.9995);
					model.updateMatrixWorld(true);
					boxUnion.union(new THREE.Box3().setFromObject(model));
				}

				const unionSize = boxUnion.getSize(new THREE.Vector3());
				const unionCenter = boxUnion.getCenter(new THREE.Vector3());
				modelSize.copy(unionSize);

				// Keep the open box centered between top header/hint and bottom CTA/mobile caption
				targetCenter.set(unionCenter.x, unionCenter.y * 0.92, unionCenter.z);

				// Soft warm studio contact shadow directly under the box base
				const shadowPlane = new THREE.Mesh(
					new THREE.PlaneGeometry(2.4, 2.4),
					new THREE.ShadowMaterial({
						color: SHADOW_HEX,
						opacity: 0.16,
					}),
				);
				shadowPlane.rotation.x = -Math.PI / 2;
				shadowPlane.position.set(unionCenter.x, boxClosed.min.y - 0.001, unionCenter.z);
				shadowPlane.receiveShadow = true;
				scene.add(shadowPlane);

				targetProgress = computeScrollProgress();
				currentProgress = targetProgress;
				applyAnimationProgress(currentProgress);

				updateCameraFraming();
				if (renderer && camera) {
					renderer.render(scene, camera);
				}

				canvas.dataset.ready = 'true';
				requestRender();
			},
			undefined,
			() => {
				if (!disposed) {
					showFallback();
				}
			},
		);

		resizeObserver.observe(viewerFrame);
	};

	setupScene();

	// Pause WebGL loop when browser skips rendering via content-visibility: auto
	const supportsContentVisibility = 'contentVisibility' in document.documentElement.style;
	let fallbackVisibilityObserver: IntersectionObserver | null = null;

	const onContentVisibilityChange = (event: Event) => {
		const cvEvent = event as ContentVisibilityEvent;
		isSkipped = Boolean(cvEvent.skipped);
		if (isSkipped) {
			stopLoop();
		} else {
			targetProgress = computeScrollProgress();
			if (!hasWebGL) {
				syncOverlayUI(targetProgress);
			} else {
				requestRender();
			}
		}
	};

	if (supportsContentVisibility) {
		viewerFrame.addEventListener(
			'contentvisibilityautostatechange',
			onContentVisibilityChange,
		);
	} else {
		fallbackVisibilityObserver = new IntersectionObserver(
			(entries) => {
				const visible = entries.some((entry) => entry.isIntersecting);
				isSkipped = !visible;
				if (isSkipped) {
					stopLoop();
				} else {
					targetProgress = computeScrollProgress();
					if (!hasWebGL) {
						syncOverlayUI(targetProgress);
					} else {
						requestRender();
					}
				}
			},
			{ rootMargin: '200px 0px' },
		);
		fallbackVisibilityObserver.observe(viewerFrame);
	}

	reducedMotionQuery.addEventListener('change', onReducedMotionChange);

	return () => {
		disposed = true;
		stopLoop();
		resizeObserver.disconnect();
		fallbackVisibilityObserver?.disconnect();
		viewerFrame.removeEventListener(
			'contentvisibilityautostatechange',
			onContentVisibilityChange,
		);
		window.removeEventListener('scroll', onScroll);
		document.removeEventListener('visibilitychange', onVisibilityChange);
		reducedMotionQuery.removeEventListener('change', onReducedMotionChange);

		envRenderTarget?.dispose();
		pmremGenerator?.dispose();
		renderer?.dispose();
	};
}
