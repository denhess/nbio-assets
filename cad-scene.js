/**
 * AUXO V — scroll-driven CAD scene.
 *
 * Physically-based / realistic render setup (after the Three.js Journey
 * "Realistic render" lesson): ACES filmic tone mapping + tuned exposure,
 * sRGB output, image-based lighting from a PMREM'd RoomEnvironment for soft
 * global illumination, a warm key + cool rim/fill, and soft contact shadows
 * cleaned up with shadow.normalBias (kills acne on the rounded geometry).
 *
 * Scroll choreography across the pinned section:
 *   establishing (whole device, small) → dolly INTO the on-board touchscreen →
 *   hold at full zoom while the UI crossfades START → RECIPES → MONITORING →
 *   ease back OUT to the establishing shot. A continuous time-based float keeps
 *   the scene alive between scroll ticks (damped to zero at full zoom).
 *
 * Externalised from index.html for readability; still build-less — resolved
 * through the page's <script type="importmap"> and served over HTTP.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SAOPass } from "three/addons/postprocessing/SAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const cadStage = document.querySelector("[data-cad-stage]");
const cadCanvas = document.querySelector("[data-cad-canvas]");
const cadSteps = Array.from(document.querySelectorAll("[data-cad-step]"));
const cadCopies = Array.from(document.querySelectorAll("[data-cad-copy]"));
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (cadStage && cadCanvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({
    canvas: cadCanvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance"
  });
  const clock = new THREE.Clock();
  const scrollRig = new THREE.Group();
  const spinRig = new THREE.Group();
  let cadProgress = 0;   // smoothed scroll progress that actually drives the scene
  let targetProgress = 0; // raw scroll progress; cadProgress eases toward this
  let loadedModel = null;

  // --- Scroll-framing state ---------------------------------------------------
  let framingReady = false;
  let guiMesh = null;
  let currentFocus = 0;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const guiWorldPos = new THREE.Vector3();
  const guiNormalWorld = new THREE.Vector3();
  const guiLocalNormal = new THREE.Vector3(0, 1, 0);
  const normalMat = new THREE.Matrix3();
  const wideCam = new THREE.Vector3();
  const camEnd = new THREE.Vector3();
  const wideTarget = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const metrics = { modelHeight: 1.4, guiFaceH: 0.5, guiFaceW: 0.35 };

  // Framing tuning.
  const WIDE_CENTER_Y = 0.0; // model vertical centre in world (was -0.4 → sat too low)
  const WIDE_RAISE = 0.0;    // extra camera height for the establishing shot
  const WIDE_MARGIN = 1.55;  // >1 keeps the whole product small/contained early on
  const GUI_FILL = 1.06;     // >1 leaves a hair of margin so the UI stays fully visible
  const GUI_CAM_DROP = 0.05; // lowers the camera a touch at full zoom on the GUI

  // --- Choreography keyframes -------------------------------------------------
  // Each stop carries: p (scroll fraction), z (0 = wide, 1 = GUI fills frame),
  // yaw (device rotation), screen (0 START → 1 RECIPES → 2 MONITORING). Segments
  // ease with smoothstep so the device settles at every stop (dwell feel).
  //
  //   start ON the GUI → cycle screens (easing slightly out each time) → zoom
  //   all the way out, rotating to reveal AUXO from the side.
  const KF = [
    { p: 0.00, z: 1.00, yaw: -0.03, screen: 0 }, // start zoomed on the GUI (START)
    { p: 0.12, z: 1.00, yaw: -0.03, screen: 0 }, // dwell on START
    { p: 0.22, z: 0.90, yaw: -0.05, screen: 1 }, // → RECIPES, ease slightly out
    { p: 0.34, z: 0.90, yaw: -0.05, screen: 1 }, // dwell on RECIPES
    { p: 0.44, z: 0.78, yaw: -0.08, screen: 2 }, // → MONITORING, ease further out
    { p: 0.56, z: 0.78, yaw: -0.08, screen: 2 }, // dwell on MONITORING
    { p: 0.80, z: 0.34, yaw: -0.32, screen: 2 }, // zoom out, device revealed
    { p: 1.00, z: 0.00, yaw: -0.66, screen: 2 }  // fully out — AUXO from the side
  ];

  const sampleKF = (p) => {
    const c = THREE.MathUtils.clamp(p, 0, 1);
    let a = KF[0];
    let b = KF[KF.length - 1];
    for (let i = 0; i < KF.length - 1; i++) {
      if (c >= KF[i].p && c <= KF[i + 1].p) { a = KF[i]; b = KF[i + 1]; break; }
    }
    const t = THREE.MathUtils.smoothstep(c, a.p, b.p); // eased within the segment
    return {
      z: THREE.MathUtils.lerp(a.z, b.z, t),
      yaw: THREE.MathUtils.lerp(a.yaw, b.yaw, t),
      screen: THREE.MathUtils.lerp(a.screen, b.screen, t)
    };
  };

  camera.position.set(0, 0, 5.4);
  scrollRig.position.set(0, WIDE_CENTER_Y, 0);
  scrollRig.rotation.set(0.05, -0.16, 0);
  scrollRig.add(spinRig);
  scene.add(scrollRig);

  // Opaque dark background (the bloom composer can't preserve canvas alpha).
  // The clear colour is chosen so that AFTER tone mapping it still matches the
  // section CSS (#080c11) — raising exposure lightens it, so it is set darker
  // here to compensate and avoid a visible canvas rectangle seam.
  renderer.setClearColor(0x06080a, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.4; // a touch darker again (was 0.5)
  // Ground shadow is a soft contact shadow (below), not a shadow map.
  renderer.shadowMap.enabled = false;

  // Image-based lighting → soft global illumination + realistic reflections.
  // Reflections + IBL come from the standard procedural RoomEnvironment (a
  // neutral studio). A lab HDR was tried but blew out the white body; a live
  // cube-probe before that smeared "weird lines" — the plain studio env reads
  // cleanest here.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const roomScene = new RoomEnvironment(renderer);
  scene.environment = pmremGenerator.fromScene(roomScene, 0.04).texture;
  roomScene.dispose();
  pmremGenerator.dispose();

  // Warm key light (shaping only; ground shadow is the soft contact shadow below).
  const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.0);
  keyLight.position.set(4.2, 6.0, 5.2);
  scene.add(keyLight);

  // Cool rim for separation from the dark background.
  const rimLight = new THREE.DirectionalLight(0x9bc7ff, 1.1);
  rimLight.position.set(-5.4, 2.8, -4.8);
  scene.add(rimLight);

  // Sky/ground bounce fill.
  const fillLight = new THREE.HemisphereLight(0xdbe6ff, 0x0a0c10, 0.45);
  scene.add(fillLight);

  // --- Soft contact shadow (three.js webgl_shadow_contact technique) ---------
  // Render the scene depth from an up-looking ortho camera at the model base,
  // then blur it twice into a transparent texture shown on a ground plane.
  // Gives a soft, realistic contact shadow with no hard shadow-map edges.
  const SHADOW_PLANE = 3.2;   // catcher size (world units)
  const SHADOW_CAM_H = 1.4;   // how far up the object casts a shadow
  const SHADOW_BLUR = 3.4;
  const SHADOW_OPACITY = 0.9;
  const SHADOW_DARKNESS = 1.4;

  const shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  const shadowRT = new THREE.WebGLRenderTarget(512, 512);
  shadowRT.texture.generateMipmaps = false;
  const shadowRTBlur = new THREE.WebGLRenderTarget(512, 512);
  shadowRTBlur.texture.generateMipmaps = false;

  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(SHADOW_PLANE, SHADOW_PLANE).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: shadowRT.texture,
      transparent: true,
      opacity: SHADOW_OPACITY,
      depthWrite: false,
      toneMapped: false
    })
  );
  shadowPlane.renderOrder = -1;
  shadowGroup.add(shadowPlane);

  // Invisible helper plane used only to run the blur passes fullscreen.
  const blurPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(SHADOW_PLANE, SHADOW_PLANE).rotateX(Math.PI / 2)
  );
  blurPlane.visible = false;
  shadowGroup.add(blurPlane);

  const shadowCamera = new THREE.OrthographicCamera(
    -SHADOW_PLANE / 2, SHADOW_PLANE / 2, SHADOW_PLANE / 2, -SHADOW_PLANE / 2, 0, SHADOW_CAM_H
  );
  shadowCamera.rotation.x = Math.PI / 2; // look straight up
  shadowGroup.add(shadowCamera);

  // Depth material that writes shadow density into the alpha channel.
  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.userData.darkness = { value: SHADOW_DARKNESS };
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = depthMaterial.userData.darkness;
    shader.fragmentShader = "uniform float darkness;\n" + shader.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );"
    );
  };
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;

  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  hBlur.depthTest = false;
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  vBlur.depthTest = false;

  const blurShadow = (amount) => {
    blurPlane.visible = true;
    blurPlane.material = hBlur;
    hBlur.uniforms.tDiffuse.value = shadowRT.texture;
    hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(shadowRTBlur);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.material = vBlur;
    vBlur.uniforms.tDiffuse.value = shadowRTBlur.texture;
    vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(shadowRT);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.visible = false;
  };

  const renderShadow = () => {
    const prevBg = scene.background;
    const prevAlpha = renderer.getClearAlpha();
    scene.background = null;
    renderer.setClearAlpha(0); // shadow density lives in the alpha channel
    shadowPlane.visible = false; // don't capture the catcher itself
    scene.overrideMaterial = depthMaterial;
    renderer.setRenderTarget(shadowRT);
    renderer.render(scene, shadowCamera);
    scene.overrideMaterial = null;
    blurShadow(SHADOW_BLUR);
    blurShadow(SHADOW_BLUR * 0.4);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(prevAlpha);
    shadowPlane.visible = true;
    scene.background = prevBg;
  };

  // Postprocessing: a gentle bloom so only the bright LED emissive glows.
  // High threshold keeps the (much dimmer) lit body out of the bloom.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Ambient occlusion — soft contact darkening in the recesses (screen bezel,
  // panel gaps, the base slot) that plain IBL alone does not produce.
  const saoPass = new SAOPass(scene, camera);
  saoPass.params.saoBias = 0.4;
  saoPass.params.saoIntensity = 0.16;
  saoPass.params.saoScale = 10;
  saoPass.params.saoKernelRadius = 46;
  saoPass.params.saoMinResolution = 0;
  saoPass.params.saoBlur = true;
  saoPass.params.saoBlurRadius = 10;
  saoPass.params.saoBlurStdDev = 6;
  saoPass.params.saoBlurDepthCutoff = 0.02;
  composer.addPass(saoPass);

  // Bloom disabled — the CAD model is shown without any glow effect.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, 0.32, 1.15);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  const setCadStep = (progress) => {
    // Steps/copy follow the GUI crossfade: START → RECIPES → MONITORING, which
    // only advances once the camera is zoomed into the screen.
    const seg = sampleKF(progress).screen; // 0..2 across the three screens
    const activeIndex = seg < 0.5 ? 0 : seg < 1.5 ? 1 : 2;
    cadSteps.forEach((step, index) => {
      step.classList.toggle("is-active", index === activeIndex);
    });
    cadCopies.forEach((copy, index) => {
      copy.classList.toggle("is-active", index === activeIndex);
    });
  };

  const resizeCad = () => {
    const bounds = cadCanvas.parentElement.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const tuneModelMaterial = (material) => {
    if (!material) return;
    const name = (material.name || "").toLowerCase();
    const hasRough = "roughness" in material && typeof material.roughness === "number";

    if (name.startsWith("blue")) {
      // Blue body: semi-gloss — a slightly blurred (not mirror) reflection of
      // the environment, so it reads as a coated painted surface.
      if (hasRough) material.roughness = 0.34;
      if ("metalness" in material) material.metalness = 0.0;
      if ("envMapIntensity" in material) material.envMapIntensity = 1.35;
    } else if (name.startsWith("white") || name.includes("grey")) {
      // White/grey shells: fully matte with NO environment reflection — roughness
      // 1.0 kills any glossy/mirror response and the env contribution is dropped
      // low, so the back body is shaped only by the direct lights.
      if (hasRough) material.roughness = 1.0;
      if ("metalness" in material) material.metalness = 0.0;
      if ("envMapIntensity" in material) material.envMapIntensity = 0.25;
    } else {
      if (hasRough) material.roughness = THREE.MathUtils.clamp(material.roughness, 0.24, 0.85);
      if ("envMapIntensity" in material) material.envMapIntensity = 1.1;
    }

    // No emissive glow on the body (the GUI screen is handled separately).
    if (material.emissive && "emissiveIntensity" in material) {
      material.emissiveIntensity = 0;
    }

    material.needsUpdate = true;
  };

  const normalizeModel = (model) => {
    // Scale to a common size FIRST, then recenter from the post-scale bounds.
    // Subtracting an unscaled center before scaling leaves off-origin models
    // (like the tall AUXO tower, whose geometry sits well above its own origin)
    // translated far outside the camera frame.
    const preBounds = new THREE.Box3().setFromObject(model);
    const size = preBounds.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z) || 1;
    model.scale.setScalar(1.4 / maxDimension);

    const scaledBounds = new THREE.Box3().setFromObject(model);
    const center = scaledBounds.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (Array.isArray(child.material)) {
        child.material.forEach(tuneModelMaterial);
      } else {
        tuneModelMaterial(child.material);
      }
    });

    return model;
  };

  const easeInOut = (t) => t * t * (3 - 2 * t);

  // --- GUI screen: crossfaded UI screenshots on the model's "GUI" plane -------
  // The GLB carries a named "GUI" plane (UV-mapped, faces +Z). We composite the
  // three UI captures onto a 2D canvas and drive the crossfade from scroll, then
  // show it as an emissive + glossy (reflective) touchscreen.
  const SCREEN_SRCS = [
    "assets/gui/gui-start.png",
    "assets/gui/gui-recipes.png",
    "assets/gui/gui-monitoring.png"
  ];
  const screenImages = [];
  let screenTex = null;
  let screenCanvas = null;
  let sctx = null;
  let lastDrawnFocus = -1;

  const drawCover = (img) => {
    const cw = screenCanvas.width;
    const ch = screenCanvas.height;
    const ir = img.width / img.height;
    let dw;
    let dh;
    if (ir > cw / ch) { dh = ch; dw = ch * ir; } else { dw = cw; dh = cw / ir; }
    sctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };

  const drawScreen = (focus) => {
    if (!sctx) return;
    const n = SCREEN_SRCS.length;
    const seg = THREE.MathUtils.clamp(focus, 0, 1) * (n - 1);
    const i0 = Math.min(Math.floor(seg), n - 2);
    const t = easeInOut(seg - i0);
    sctx.fillStyle = "#05070b";
    sctx.fillRect(0, 0, screenCanvas.width, screenCanvas.height);
    if (screenImages[i0]) drawCover(screenImages[i0]);
    if (screenImages[i0 + 1] && t > 0) {
      sctx.globalAlpha = t;
      drawCover(screenImages[i0 + 1]);
      sctx.globalAlpha = 1;
    }
    screenTex.needsUpdate = true;
  };

  const setupGuiScreen = (faceW, faceH) => {
    if (!guiMesh) return;
    screenCanvas = document.createElement("canvas");
    screenCanvas.height = 1280;
    screenCanvas.width = Math.max(2, Math.round(1280 * (faceW / faceH)));
    sctx = screenCanvas.getContext("2d");
    sctx.fillStyle = "#05070b";
    sctx.fillRect(0, 0, screenCanvas.width, screenCanvas.height);

    screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    screenTex.flipY = false; // glTF UVs assume a top-left origin
    screenTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    guiMesh.material = new THREE.MeshStandardMaterial({
      map: screenTex,
      emissive: 0xffffff,
      emissiveMap: screenTex,
      emissiveIntensity: 2.3,  // reads bright against the 0.32 exposure without blowing out
      roughness: 0.2,          // glossy glass → soft, slightly blurred env reflection
      metalness: 0.0,
      envMapIntensity: 1.25,   // lets the environment read lightly over the UI
      side: THREE.DoubleSide
    });

    SCREEN_SRCS.forEach((src, i) => {
      const img = new Image();
      img.onload = () => {
        screenImages[i] = img;
        lastDrawnFocus = -1;
        drawScreen(currentFocus);
      };
      img.src = src;
    });
  };

  const setupCadScroll = () => {
    if (!window.gsap || !window.ScrollTrigger || prefersReducedMotion.matches) {
      setCadStep(0);
      return;
    }

    window.gsap.registerPlugin(window.ScrollTrigger);
    // The full choreography is computed per-frame in renderCad() from cadProgress
    // (see below) so the camera can track the live world position of the GUI
    // plane. ScrollTrigger only needs to publish the (scrub-smoothed) progress.
    window.ScrollTrigger.create({
      trigger: cadStage,
      start: "top top",
      end: "bottom bottom",
      // No GSAP scrub lag here — renderCad() eases cadProgress toward this raw
      // target every frame (see SCROLL_TAU), which stays smooth *during* active
      // wheel scrolling, not only when the wheel is released.
      scrub: true,
      onUpdate: (self) => {
        targetProgress = self.progress;
        setCadStep(self.progress);
      }
    });
  };

  const SCROLL_TAU = 0.16; // seconds — smoothing time constant for scroll easing

  const renderCad = () => {
    const delta = Math.min(clock.getDelta(), 0.05);

    // Critically-smooth exponential easing of the scroll progress every frame, so
    // the product glides toward the scroll position instead of snapping to each
    // discrete wheel tick and stopping dead when the wheel stops.
    cadProgress += (targetProgress - cadProgress) * (1 - Math.exp(-delta / SCROLL_TAU));
    const p = cadProgress;

    if (framingReady && loadedModel) {
      const kf = sampleKF(p);
      const zoom = kf.z;               // 0 wide → 1 GUI fills → back out
      const eZ = easeInOut(zoom);      // eased for the camera dolly

      // --- Pose: keyframed yaw carries the side-view → turn-in → frontal motion;
      // a little pitch flattens out as we zoom in.
      scrollRig.position.set(0, WIDE_CENTER_Y, 0);
      scrollRig.rotation.set(
        THREE.MathUtils.lerp(0.06, 0.0, zoom),
        kf.yaw,
        0
      );

      // --- Continuous "alive" float so the scene never reads as frozen between
      // scroll ticks. Driven by elapsed time (not scroll) and damped to nothing
      // as we zoom in, so the screen stays rock-steady when it fills the frame.
      const alive = prefersReducedMotion.matches ? 0 : (1 - zoom);
      const t = clock.elapsedTime;
      spinRig.rotation.y = Math.sin(t * 0.34) * 0.055 * alive;
      spinRig.rotation.x = Math.sin(t * 0.26 + 1.3) * 0.026 * alive;
      spinRig.position.set(0, Math.sin(t * 0.4 + 2.1) * 0.014 * alive, 0);

      scrollRig.updateMatrixWorld(true);

      // Screen crossfade follows the keyframed `screen` value (0..2). The dwell
      // keyframes hold it on clean integers, so each UI rests before dissolving.
      currentFocus = THREE.MathUtils.clamp(kf.screen, 0, 2) / 2;

      // Live GUI world centre + surface normal (tracks the eased pose exactly).
      guiMesh.getWorldPosition(guiWorldPos);
      normalMat.getNormalMatrix(guiMesh.matrixWorld);
      guiNormalWorld.copy(guiLocalNormal).applyMatrix3(normalMat).normalize();
      if (guiNormalWorld.z < 0) guiNormalWorld.negate(); // always face the viewer

      // Full-zoom framing: dolly straight down the screen normal, far enough that
      // the GUI is contained in both axes of the (live-aspect) canvas.
      const tanHalf = Math.tan(fovRad * 0.5);
      const dGuiH = (metrics.guiFaceH * 0.5) / tanHalf;
      const dGuiW = (metrics.guiFaceW * 0.5) / (tanHalf * Math.max(camera.aspect, 0.0001));
      const dGui = Math.max(dGuiH, dGuiW) * GUI_FILL;
      camEnd.copy(guiNormalWorld).multiplyScalar(dGui).add(guiWorldPos);
      camEnd.y -= GUI_CAM_DROP; // sit the camera slightly lower at the GUI view

      // Establishing framing: whole product, centred and small.
      const dWide = (metrics.modelHeight * 0.5) / tanHalf * WIDE_MARGIN;
      wideTarget.set(0, WIDE_CENTER_Y, 0);
      wideCam.set(0, WIDE_CENTER_Y + WIDE_RAISE, dWide);

      camera.position.lerpVectors(wideCam, camEnd, eZ);
      lookTarget.lerpVectors(wideTarget, guiWorldPos, eZ);
      camera.lookAt(lookTarget);

      // Redraw the screen only when the crossfade has moved meaningfully.
      if (screenTex && Math.abs(currentFocus - lastDrawnFocus) > 0.004) {
        drawScreen(currentFocus);
        lastDrawnFocus = currentFocus;
      }
    } else {
      camera.lookAt(0, 0, 0);
    }

    if (loadedModel) renderShadow();
    composer.render();
    window.requestAnimationFrame(renderCad);
  };

  resizeCad();
  renderCad();

  new GLTFLoader().load(
    "assets/models/AUXO.glb",
    (gltf) => {
      loadedModel = normalizeModel(gltf.scene);
      spinRig.add(loadedModel);
      guiMesh = loadedModel.getObjectByName("GUI");

      // Measure the model + GUI plane at a neutral rig pose so the framing math
      // is independent of the current scroll rotation.
      const prevPos = scrollRig.position.clone();
      const prevRot = scrollRig.rotation.clone();
      const prevSpin = spinRig.rotation.clone();
      scrollRig.position.set(0, 0, 0);
      scrollRig.rotation.set(0, 0, 0);
      spinRig.rotation.set(0, 0, 0);
      scrollRig.updateMatrixWorld(true);

      metrics.modelHeight = new THREE.Box3().setFromObject(loadedModel).getSize(new THREE.Vector3()).y || 1.4;

      if (guiMesh) {
        const guiSize = new THREE.Box3().setFromObject(guiMesh).getSize(new THREE.Vector3());
        metrics.guiFaceH = guiSize.y || 0.5;
        metrics.guiFaceW = guiSize.x || 0.35;
        const nrm = guiMesh.geometry.getAttribute("normal");
        if (nrm) guiLocalNormal.set(nrm.getX(0), nrm.getY(0), nrm.getZ(0)).normalize();
        setupGuiScreen(metrics.guiFaceW, metrics.guiFaceH);
      }

      // Restore the establishing pose, then seat the contact shadow on the base.
      scrollRig.position.copy(prevPos);
      scrollRig.rotation.copy(prevRot);
      spinRig.rotation.copy(prevSpin);
      scrollRig.updateMatrixWorld(true);
      const worldBox = new THREE.Box3().setFromObject(loadedModel);
      shadowGroup.position.y = worldBox.min.y + 0.001;

      framingReady = true;
      cadStage.classList.add("is-model-loaded");
      setupCadScroll();
      if (window.ScrollTrigger) window.ScrollTrigger.refresh();
    },
    undefined,
    (error) => {
      console.warn("CAD model failed to load", error);
      cadStage.classList.add("is-model-loaded", "is-model-failed");
      setupCadScroll();
    }
  );

  window.addEventListener("resize", () => {
    resizeCad();
    if (window.ScrollTrigger) window.ScrollTrigger.refresh();
  });
}
